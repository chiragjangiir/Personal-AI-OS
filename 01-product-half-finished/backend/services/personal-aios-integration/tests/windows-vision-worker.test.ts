import {materialized} from './stream-materialized-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowsVisionWorker,windowsVisionCapability} from '../src/media/windows-vision-worker.ts';
import type {WindowsVisionSnapshot} from '../src/media/windows-vision-worker.ts';
import type {WorkerRequest} from '../src/media/processing.ts';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EVENT_SCHEMA} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {alignSegment} from '../src/media/align.ts';
import {MediaProcessor} from '../src/media/processing.ts';
const WINDOWS_VISION_BASE='https://alternate.invalid/v1',WINDOWS_VISION_MODEL='alternate-window-vision';
const config={base_url:WINDOWS_VISION_BASE,model:WINDOWS_VISION_MODEL,timeout_ms:1000,max_frames:3,max_input_bytes:1024,max_tokens:128};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
const time_range={kind:'interval' as const,timebase_id:'common',start_ms:1000,end_ms:1200};
const request:WorkerRequest={input_contract:'paios.media.full-chunks.v1',coverage:{status:'complete',missing_ranges:[],alignment_uncertainty_ms:0},event_id:'visual',segment_id:'segment',archive_revision:'archive-1',time_range,views:[
  {modality:'visual',format:'png',ref:'frame-0',time_range:{kind:'instant',timebase_id:'common',at_ms:1000},bytes:png},
  {modality:'visual',format:'png',ref:'frame-1',time_range:{kind:'instant',timebase_id:'common',at_ms:1100},bytes:png}]};
const response=(content:unknown='Red square and blue circle.',finish='stop',extra={})=>new Response(JSON.stringify({model:WINDOWS_VISION_MODEL,
 choices:[{finish_reason:finish,message:{role:'assistant',content,reasoning_content:'This must never become observed content.',...extra}}]}),{status:200});
test('one protocol request preserves both frame refs and controls, no reasoning or tool execution',async()=>{
 let calls=0;
 const fetcher=(async(url,init)=>{calls++;assert.equal(url,WINDOWS_VISION_BASE+'/chat/completions');
  const body=JSON.parse(init!.body as string);assert.equal(body.model,config.model);assert.equal(body.temperature,0);assert.equal(body.enable_thinking,false);assert.equal(body.reasoning_effort,'none');
  assert.equal(body.tools,undefined);assert.equal(body.stream,false);
  assert.equal(body.messages[0].content.filter((c:{type:string})=>c.type==='image_url').length,2);return response();}) as typeof fetch;
 const result=await new WindowsVisionWorker(config,fetcher).analyze(request,new AbortController().signal);
 assert.equal(calls,1);assert.deepEqual([result.event_id,result.segment_id,result.archive_revision,result.time_range],['visual','segment','archive-1',time_range]);
 const observed=result.content.visual_observations as {description:string;frame_refs:string[];model:string}[];
 assert.equal(observed[0]!.model,config.model);assert.equal(observed[0]!.description,'Red square and blue circle.');assert.deepEqual(observed[0]!.frame_refs,['frame-0','frame-1']);
 assert.ok(!JSON.stringify(result.content).includes('must never'));assert.deepEqual(result.speakers,[]);
});
test('empty final never promotes reasoning; truncation is partial and actual tool response is rejected',async()=>{
 await assert.rejects(new WindowsVisionWorker(config,(async()=>response('')) as typeof fetch).analyze(request,new AbortController().signal),/FINAL_CONTENT_REQUIRED/);
 const truncated=await new WindowsVisionWorker(config,(async()=>response('red','length')) as typeof fetch).analyze(request,new AbortController().signal);
 assert.equal(truncated.status,'partial');assert.ok(truncated.warnings.includes('VISUAL_GENERATION_TRUNCATED'));
 await assert.rejects(new WindowsVisionWorker(config,(async()=>response('red','stop',{tool_calls:[{id:'unexecuted'}]})) as typeof fetch).analyze(request,new AbortController().signal),/FINAL_CONTENT_REQUIRED/);
});
test('input/response scope, format, byte budget and changed model fail rather than fabricate observations',async()=>{
 const worker=new WindowsVisionWorker({...config,max_input_bytes:32},(async()=>response()) as typeof fetch);
 await assert.rejects(worker.analyze(request,new AbortController().signal),/BYTE_BUDGET/);
 const bad={...request,views:[{...request.views[0]!,time_range:{kind:'instant' as const,timebase_id:'different',at_ms:1000}}]};
 await assert.rejects(new WindowsVisionWorker(config,(async()=>response()) as typeof fetch).analyze(bad,new AbortController().signal),/TIMEBASE/);
 await assert.rejects(new WindowsVisionWorker(config,(async()=>new Response(JSON.stringify({model:'different',choices:[]}))) as typeof fetch).analyze(request,new AbortController().signal),/RESPONSE_MODEL/);
 await assert.rejects(new WindowsVisionWorker(config,(async()=>new Response('x'.repeat(65537))) as typeof fetch).analyze(request,new AbortController().signal),/OUTPUT_BUDGET/);
});
test('bounded HTTP abort and caller cancellation preserve source ownership',async()=>{
 const hanging=(async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true});})) as typeof fetch;
 const worker=new WindowsVisionWorker({...config,timeout_ms:20},hanging);
 // Keep the event loop alive independently of AbortSignal.timeout's unref timer.
 const hold=setTimeout(()=>{},200);try{await assert.rejects(worker.analyze(request,new AbortController().signal),/timeout/i);}finally{clearTimeout(hold);}
 const controller=new AbortController();controller.abort();await assert.rejects(worker.analyze(request,controller.signal),/MEDIA_CANCELLED/);
});
test('capability needs observed PNG/counterfactual and current loaded registry health',()=>{
 const snapshot:WindowsVisionSnapshot={captured_at:'2026-10-01T08:12:25.109Z',models:[WINDOWS_VISION_MODEL],
  health:{status:'ok',loaded_model:WINDOWS_VISION_MODEL,loading_model:null,last_error:''},verified_png:true,verified_counterfactual:true};
 assert.deepEqual(windowsVisionCapability(config,snapshot).formats,['png']);assert.equal(windowsVisionCapability(config,snapshot).evidence,'real_verified');
 assert.equal(windowsVisionCapability(config,{...snapshot,verified_png:false}).evidence,'unverified');
 assert.equal(windowsVisionCapability(config,{...snapshot,health:{...snapshot.health,loaded_model:null}}).healthy,false);
});

test('authoritative align interval overlap retains original frame time and yields partial D; non-overlap never calls HTTP',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'windows-frame-overlap-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const storage=new PosixStorage(root);const archive=new StreamArchive(storage,{max_chunk_bytes:1024,max_total_bytes:2048,max_chunks:4,max_revisions:4,max_seq:4});
 const at='2026-10-01T08:24:00.000Z';
 const b=await archive.append({schema_version:EVENT_SCHEMA,event_id:'interval-visual',device_id:'test-mac',device_type:'mac',captured_at:at,
  source:{channel:'synthetic'},media_type:'visual',mime:'image/png',representation:'received_decoded_sample',payload:png},
  {principal_id:'owner',device_id:'test-mac',device_type:'mac',consent_ref:'synthetic-consent',channel:'synthetic',submission:'observation'},at,
  {track_id:'frame',stream_epoch:'e1',seq:0,modality:'visual',format:'png',source_range:{kind:'interval',timebase_id:'frame-clock',stream_epoch:'e1',start_ms:0,end_ms:500}});
 const candidate={kind:'interval' as const,timebase_id:'common',start_ms:10034,end_ms:11982};
 const aligned=await alignSegment(b.event,(await materialized(storage,b)),candidate,'visual_window',
  [{modality:'visual',track_id:'frame',stream_epoch:'e1',source_timebase_id:'frame-clock',target_timebase_id:'common',offset_ms:10000,drift_ppm:0,uncertainty_ms:0,basis_ref:'fixture-clock'}],
  storage,{max_chunks:4,max_visual_refs:1,max_frame_gap_ms:100,max_uncertainty_ms:1});
 assert.deepEqual(aligned.views[0]!.mapped_range,{kind:'interval',timebase_id:'common',start_ms:10000,end_ms:10500});
 let calls=0;
 const fetcher=(async(_url,init)=>{calls++;const payload=JSON.parse(init!.body as string);const descriptors=payload.messages[0].content.filter((c:{type:string})=>c.type==='text').map((c:{text:string})=>c.text).join('\n');
  assert.ok(descriptors.includes('10034'));assert.ok(descriptors.includes('10000'));assert.ok(descriptors.includes('10500'));return response();}) as typeof fetch;
 const worker=new WindowsVisionWorker(config,fetcher);
 const processor=new MediaProcessor(storage,new Map([['windows-vision',worker]]),{policy_version:'overlap-test',max_inflight:1,max_input_bytes:1024,timeout_ms:1000,allow_external:true,allow_replay:false,allow_partial:true});
 const prepared=await processor.prepareRequest(aligned.segment,aligned.views);
 const d=await processor.process(aligned.segment,aligned.views,[{id:'windows-vision',version:WINDOWS_VISION_MODEL,modalities:['visual'],formats:['png'],joint_av:false,healthy:true,permitted:true,max_duration_ms:10000,execution:'external',evidence:'real_verified'}]);
 assert.equal(calls,1);assert.equal(d.quality.status,'partial');assert.ok(d.quality.warnings.includes('FRAME_SPANS_ANALYSIS_WINDOW'));
 const observations=d.content.visual_observations as {time_range:unknown;frames:{time_range:unknown}[]}[];
 assert.deepEqual(observations[0]!.time_range,candidate);assert.deepEqual(observations[0]!.frames[0]!.time_range,aligned.views[0]!.mapped_range);
 const point=await worker.analyze({...prepared,time_range:{kind:'instant',timebase_id:'common',at_ms:10034}},new AbortController().signal);
 assert.equal(point.status,'partial');assert.ok(point.warnings.includes('FRAME_SPANS_ANALYSIS_WINDOW'));
 for(const outside of [{kind:'interval' as const,timebase_id:'common',start_ms:10500,end_ms:10900},
  {kind:'instant' as const,timebase_id:'common',at_ms:10500}])
  await assert.rejects(worker.analyze({...prepared,time_range:outside},new AbortController().signal),/FRAME_SCOPE/);
 assert.equal(calls,2);
 const instantAtEnd={...request,views:[{...request.views[0]!,time_range:{kind:'instant' as const,timebase_id:'common',at_ms:1200}}]};
 await assert.rejects(worker.analyze(instantAtEnd,new AbortController().signal),/FRAME_SCOPE/);assert.equal(calls,2);
});

test('instant PNG exactly on instant analysis scope keeps existing complete behavior',async()=>{
 const point=request.views[0]!.time_range;
 const result=await new WindowsVisionWorker(config,(async()=>response()) as typeof fetch).analyze({...request,time_range:point,views:[request.views[0]!]},new AbortController().signal);
 assert.equal(result.status,'complete');assert.ok(!result.warnings.includes('FRAME_SPANS_ANALYSIS_WINDOW'));
});
