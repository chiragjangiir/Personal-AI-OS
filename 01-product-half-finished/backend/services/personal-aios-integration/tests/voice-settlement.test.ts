import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputAuthority, type OutputContext, type OutputAck, type OpenReplyRequest, type RunReceiptRead, type ServiceReceipt } from '../src/output.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { inspectWav } from '../src/tts.ts';
import { ContractError, digest, EVENT_SCHEMA } from '../src/contracts.ts';

const now = '2026-10-01T00:00:00.000Z';
async function fixture(t: test.TestContext) {
  const path = await fs.mkdtemp(join(tmpdir(), 'paios-output-'));
  t.after(() => fs.rm(path, {recursive: true, force: true}));
  const storage = new PosixStorage(path);
  const d = await new UnifiedIngress(new RawArchive(storage, 4096, () => now)).accept({
    schema_version: EVENT_SCHEMA, event_id: 'event-one', device_id: 'mac-one', device_type: 'mac',
    captured_at: now, source: {channel: 'text'}, media_type: 'text', mime: 'text/plain;charset=utf-8',
    representation: 'uploaded_original', payload: Buffer.from('hello')},
  {principal_id: 'owner-one', device_id: 'mac-one', device_type: 'mac', consent_ref: 'consent-one',
    channel: 'text', submission: 'explicit_text'});
  const ctx: OutputContext = {principal_id: 'owner-one', run_id: 'run-one', session_id: 'session-one',
    tool_call_id: 'tool-one', d, target: {device_id: 'mac-one', device_type: 'mac', route_version: 'route-one', output_modes: ['text']}};
  return {path, storage, ctx, out: new OutputAuthority(storage, {chunkChars: 3})};
}
const native = {run_id: 'run-one', session_id: 'session-one', conversation_session_id: 'session-one', status: 'completed', output: '你好ABC😀'};
function ack(chunk: {output_id: string; reply_id: string; reply_epoch: number; target_device_id: string; route_version: string}, seq: number, status: OutputAck['status'] = 'rendered'): OutputAck {
  return {...chunk, highest_contiguous_seq: seq, status, observed_at: now};
}

function wavFixture() {
  const bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);return inspectWav(bytes);
}
async function deferredOutput(t:test.TestContext,mode:'voice'|'text_and_voice'='text_and_voice') {
 const {storage,ctx}=await fixture(t),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),settled=Promise.withResolvers<void>();let calls=0;let fault:unknown;
 const trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}};
 const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{calls++;entered.resolve();await release.promise;return wavFixture();}}});
 out.setVoiceOwner(async(_ctx,error)=>{fault=error;settled.resolve();});await out.open(trusted,{reply_mode:mode});
 t.after(async()=>{release.resolve();await out.close();});return {storage,ctx:trusted,out,entered,release,settled,calls:()=>calls,fault:()=>fault};
}
test('durable text returns before provider settles, then voice independently ready and ACK bound',async t=>{
 const f=await deferredOutput(t);const result=await f.out.seal(f.ctx,native);assert.equal(result.voice_status,'pending');await f.entered.promise;
 const first=await f.out.readFinalized(f.ctx);assert.equal(first.chunks.map(x=>x.text).join(''),native.output);assert.equal(first.result.reply_status,'complete');assert.equal(first.voice_chunks.length,0);
 assert.equal((await f.out.seal(f.ctx,native)).voice_status,'pending');assert.equal(f.calls(),1);
 await f.out.ack(f.ctx,ack(first.chunks[0]!,first.chunks.length));f.release.resolve();await f.settled.promise;
 const ready=await f.out.readFinalized(f.ctx);assert.equal(ready.result.voice_status,'ready');assert.equal(ready.result.delivery_status,'partial');assert.equal(ready.voice_chunks.length,1);
 await f.out.ack(f.ctx,ack(ready.voice_chunks[0]!,1,'played'));assert.equal((await f.out.readFinalized(f.ctx)).result.delivery_status,'played');
});
test('voice-only has zero captions before and after independent settlement',async t=>{
 const f=await deferredOutput(t,'voice');await f.out.seal(f.ctx,native);assert.deepEqual((await f.out.readFinalized(f.ctx)).chunks,[]);f.release.resolve();await f.settled.promise;assert.deepEqual((await f.out.readFinalized(f.ctx)).chunks,[]);
});
test('TTS failure retains durable text; explicit retry never starts another native run',async t=>{
 const {storage,ctx}=await fixture(t);const trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}};let calls=0;const first=Promise.withResolvers<void>();
 const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{if(++calls===1)throw Error('down');return wavFixture();}}});out.setVoiceOwner(async()=>first.resolve());t.after(()=>out.close());await out.open(trusted,{reply_mode:'text_and_voice'});
 await out.seal(trusted,native);await first.promise;const failed=await out.readFinalized(trusted);assert.equal(failed.result.voice_status,'failed');assert.equal(failed.result.reply_status,'complete');assert.equal(failed.chunks.map(x=>x.text).join(''),native.output);
 assert.equal((await out.retryVoice(trusted,native)).voice_status,'ready');assert.equal(calls,2);await assert.rejects(out.retryVoice(trusted,native),/RETRY_NOT_SAFE/);
});
test('unknown remote claim preserves text; cold owner requires explicit retry before another request',async t=>{
 const {storage,ctx}=await fixture(t);const trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}};let calls=0;const settled=Promise.withResolvers<void>();let fault:unknown;
 const faulty={read:storage.read.bind(storage),list:storage.list.bind(storage),removePending:storage.removePending.bind(storage),publish:async(n:string,k:string,b:Uint8Array)=>{if(n==='derived-audio')throw Error('disk');return storage.publish(n,k,b);}};
 const out=new OutputAuthority(faulty,{tts:{synthesize:async()=>{calls++;return wavFixture();}}});out.setVoiceOwner(async(_ctx,e)=>{fault=e;settled.resolve();});t.after(()=>out.close());await out.open(trusted,{reply_mode:'text_and_voice'});
 await out.seal(trusted,native);await settled.promise;assert.match(String(fault),/disk/);assert.equal((await out.readFinalized(trusted)).result.reply_status,'complete');
 const cold=new OutputAuthority(storage,{tts:{synthesize:async()=>{calls++;return wavFixture();}}});const reconciled=Promise.withResolvers<void>();cold.setVoiceOwner(async()=>reconciled.resolve());t.after(()=>cold.close());await cold.seal(trusted,native);await reconciled.promise;
 assert.equal((await cold.readFinalized(trusted)).result.voice_status,'reconcile_required');assert.equal(calls,1);await cold.retryVoice(trusted,native);
 assert.equal((await cold.readFinalized(trusted)).result.voice_status,'ready');assert.equal(calls,2);await assert.rejects(cold.retryVoice(trusted,native),/RETRY_NOT_SAFE/);assert.equal(calls,2);
});
test('cancel aborts owned task; late success cannot publish audio or old ACK',async t=>{
 const f=await deferredOutput(t);await f.out.seal(f.ctx,native);await f.entered.promise;await f.out.cancel(f.ctx,1);f.release.resolve();await f.out.close();const value=await f.out.readFinalized(f.ctx);
 assert.equal(value.result.reply_phase,'interrupted');assert.deepEqual(value.voice_chunks,[]);assert.deepEqual(value.chunks,[]);
});
test('close joins provider and completion listener, rejects new generation without losing text',async t=>{
 const {storage,ctx}=await fixture(t),trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}},release=Promise.withResolvers<void>(),listener=Promise.withResolvers<void>(),noticed=Promise.withResolvers<void>();
 const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{await release.promise;return wavFixture();}}});out.setVoiceOwner(async()=>{noticed.resolve();await listener.promise;});await out.open(trusted,{reply_mode:'text_and_voice'});await out.seal(trusted,native);
 let done=false;const close=out.close().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);release.resolve();await noticed.promise;assert.equal(done,false);listener.resolve();await close;assert.equal((await out.readFinalized(trusted)).chunks.map(x=>x.text).join(''),native.output);
});
test('a queued read of another durable claim expires without duplicate synthesis or declaring it unbilled',async t=>{
 const f=await deferredOutput(t);await f.out.seal(f.ctx,native);await f.entered.promise;
 const release=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),checked=Promise.withResolvers<void>();let otherCalls=0;
 const other=new OutputAuthority(f.storage,{tts:{synthesize:async()=>{otherCalls++;entered.resolve();await release.promise;return wavFixture();}}});
 other.setVoiceOwner(async context=>{if(context.run_id===f.ctx.run_id)checked.resolve();},1);t.after(async()=>{release.resolve();await other.close();});
 const blocker={...f.ctx,run_id:'read-blocker',tool_call_id:'read-blocker'};await other.open(blocker,{reply_mode:'text_and_voice'});await other.seal(blocker,{...native,run_id:blocker.run_id});await entered.promise;
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});await other.seal(f.ctx,native);t.mock.timers.tick(60001);await checked.promise;
 assert.equal(otherCalls,1);assert.equal((await other.readFinalized(f.ctx)).result.voice_status,'reconcile_required');t.mock.timers.reset();
 release.resolve();await other.close();f.release.resolve();await f.settled.promise;
});

test('cancel during derived artifact publication cannot commit a ready voice',async t=>{
 const {storage,ctx}=await fixture(t),trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}},entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let fault:unknown;
 const gated={read:storage.read.bind(storage),list:storage.list.bind(storage),removePending:storage.removePending.bind(storage),publish:async(n:string,k:string,b:Uint8Array)=>{if(n==='derived-audio'){entered.resolve();await release.promise;}return storage.publish(n,k,b);}};
 const out=new OutputAuthority(gated,{tts:{synthesize:async()=>wavFixture()}});out.setVoiceOwner(async(_ctx,e)=>{if(e)fault=e;});await out.open(trusted,{reply_mode:'text_and_voice'});await out.seal(trusted,native);await entered.promise;
 await out.cancel(trusted,1);release.resolve();await out.close();assert.match(String(fault),/OUTPUT_VOICE_CANCELLED/);const result=await out.readFinalized(trusted);assert.equal(result.result.reply_phase,'interrupted');assert.deepEqual(result.voice_chunks,[]);
});
test('close owns the task while durable claim publication is pending',async t=>{
 const {storage,ctx}=await fixture(t),trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}},entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
 const gated={read:storage.read.bind(storage),list:storage.list.bind(storage),removePending:storage.removePending.bind(storage),publish:async(n:string,k:string,b:Uint8Array)=>{if(n==='output-journal' && JSON.parse(Buffer.from(b).toString()).voice?.status==='claimed'){entered.resolve();await release.promise;}return storage.publish(n,k,b);}};
 const out=new OutputAuthority(gated,{tts:{synthesize:async()=>{calls++;return wavFixture();}}});await out.open(trusted,{reply_mode:'text_and_voice'});await out.seal(trusted,native);await entered.promise;
 let done=false;const closing=out.close().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);release.resolve();await closing;assert.equal(calls,0);assert.equal((await out.readFinalized(trusted)).result.reply_status,'complete');
});

test('synthesis saturation queues without a new durable claim, then drains in order',async t=>{
 const {storage,ctx}=await fixture(t),trusted={...ctx,target:{...ctx.target,output_modes:['text','voice']}},entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),secondDone=Promise.withResolvers<void>();let calls=0;
 const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{calls++;entered.resolve();await release.promise;return wavFixture();}}});
 out.setVoiceOwner(async(context)=>{if(context.run_id==='next')secondDone.resolve();},1);
 await out.open(trusted,{reply_mode:'text_and_voice'});await out.seal(trusted,native);await entered.promise;
 const next={...trusted,run_id:'next',tool_call_id:'next-open'},run={...native,run_id:'next'};
 await out.open(next,{reply_mode:'text_and_voice'});const queued=await out.seal(next,run);
 assert.equal(queued.voice_status,'pending');assert.equal(queued.voice_error,null);assert.equal(calls,1);
 release.resolve();await secondDone.promise;assert.equal(calls,2);assert.equal((await out.readFinalized(next)).result.voice_status,'ready');await out.close();
});
test('total voice budget refuses overflow durably, cancels a middle waiter, drains fairly, and joins shutdown',async t=>{
 const {storage,ctx}=await fixture(t),calls:string[]=[],signals:AbortSignal[]=[],gates=Array.from({length:10},()=>Promise.withResolvers<void>()),done=Array.from({length:10},()=>Promise.withResolvers<void>()),started=Array.from({length:10},()=>Promise.withResolvers<void>());
 const contexts=gates.map((_,i)=>({...ctx,run_id:'bounded-'+i,tool_call_id:'open-'+i,target:{...ctx.target,output_modes:['text','voice']}}));
 const runs=contexts.map((context,i)=>({...native,run_id:context.run_id,output:String(i)}));
 const out=new OutputAuthority(storage,{tts:{synthesize:async(text,_id,signal)=>{calls.push(text);signals.push(signal!);started[Number(text)]!.resolve();if(text==='3')throw Error('provider failure');await gates[Number(text)]!.promise;return wavFixture();}}});
 out.setVoiceOwner(async context=>done[Number(context.run_id.split('-').at(-1))]!.resolve(),2);
 t.after(async()=>{for(const gate of gates)gate.resolve();await out.close();});
 for(let i=0;i<7;i++){
  await out.open(contexts[i]!,{reply_mode:'text_and_voice'});const value=await out.seal(contexts[i]!,runs[i]!);
  assert.equal(value.voice_status,i<4?'pending':'failed');if(i>=4)assert.equal(value.voice_error,'OUTPUT_VOICE_CAPACITY_NOT_STARTED');
 }
 assert.deepEqual(calls,['0','1']);await out.cancel(contexts[2]!,1);
 await out.open(contexts[7]!,{reply_mode:'text_and_voice'});assert.equal((await out.seal(contexts[7]!,runs[7]!)).voice_status,'pending');
 gates[0]!.resolve();await done[0]!.promise;await done[3]!.promise;await started[7]!.promise;assert.deepEqual(calls,['0','1','3','7']);
 assert.equal((await out.readFinalized(contexts[3]!)).result.voice_error,'TTS_SYNTHESIS_FAILED');
 await out.open(contexts[9]!,{reply_mode:'text_and_voice'});await out.seal(contexts[9]!,runs[9]!);
 const closing=out.close();gates[1]!.resolve();gates[7]!.resolve();await closing;
 assert.ok(signals[1]!.aborted && signals[3]!.aborted);assert.deepEqual(calls,['0','1','3','7']);
 assert.equal((await out.readFinalized(contexts[9]!)).result.voice_error,'OUTPUT_VOICE_CLOSED_NOT_STARTED');
 let restartCalls=0;const cold=new OutputAuthority(storage,{tts:{synthesize:async()=>{restartCalls++;return wavFixture();}}});t.after(()=>cold.close());
 for(const i of [0,1,2,3,4,5,6,9]){await cold.seal(contexts[i]!,runs[i]!);assert.notEqual((await cold.readFinalized(contexts[i]!)).result.voice_status,'pending');}
 await cold.close();assert.equal(restartCalls,0);
});
test('retained voice bytes and persisted queue age are bounded while the provider is blocked',async t=>{
 const {storage,ctx}=await fixture(t),release=Promise.withResolvers<void>(),expired=Promise.withResolvers<void>();let calls=0;
 const out=new OutputAuthority(storage,{maxTextBytes:20000,tts:{synthesize:async()=>{calls++;await release.promise;return wavFixture();}}});out.setVoiceOwner(async context=>{if(context.run_id==='aged')expired.resolve();},1);
 t.after(async()=>{release.resolve();await out.close();});
 const active={...ctx,target:{...ctx.target,output_modes:['text','voice']}},large={...native,output:'x'.repeat(12000)};
 await out.open(active,{reply_mode:'text_and_voice'});assert.equal((await out.seal(active,large)).voice_status,'pending');
 const second={...active,run_id:'bytes',tool_call_id:'bytes'};await out.open(second,{reply_mode:'text_and_voice'});
 assert.equal((await out.seal(second,{...large,run_id:'bytes'})).voice_error,'OUTPUT_VOICE_CAPACITY_NOT_STARTED');
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const aged={...active,run_id:'aged',tool_call_id:'aged'};await out.open(aged,{reply_mode:'text_and_voice'});await out.seal(aged,{...native,run_id:'aged'});
 t.mock.timers.tick(60001);await expired.promise;
 assert.equal((await out.readFinalized(aged)).result.voice_error,'OUTPUT_VOICE_WAIT_EXPIRED_NOT_STARTED');assert.equal(calls,1);t.mock.timers.reset();
 release.resolve();assert.equal((await out.retryVoice(aged,{...native,run_id:'aged'})).voice_status,'ready');assert.equal(calls,2);
});
test('cancel queued synthesis does not call the remote provider',async t=>{
 const f=await deferredOutput(t); // Use a separate authority with one synthesis slot.
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
 const out=new OutputAuthority(f.storage,{tts:{synthesize:async()=>{calls++;entered.resolve();await release.promise;return wavFixture();}}});out.setVoiceOwner(async()=>{},1);
 await out.seal(f.ctx,native);await entered.promise;
 const next={...f.ctx,run_id:'queued',tool_call_id:'queued-open'},run={...native,run_id:'queued'};await out.open(next,{reply_mode:'text_and_voice'});await out.seal(next,run);
 await out.cancel(next,1);release.resolve();await out.close();assert.equal(calls,1);assert.equal((await out.readFinalized(next)).result.reply_phase,'interrupted');
});
test('stream chunks are playable before completion, replay only unplayed sequences, and fence cancellation',async t=>{
 const {storage,ctx}=await fixture(t),trusted={...ctx,target:{...ctx.target,output_modes:['voice']}},release=Promise.withResolvers<void>(),first=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();let calls=0;
 const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{throw Error('must stream');},stream:async function*(){calls++;yield wavFixture();await release.promise;yield wavFixture();}}});
 out.setVoiceOwner(async context=>{const value=await out.readFinalized(context);if(value.result.voice_status==='pending' && value.voice_chunks.length)first.resolve();if(value.result.voice_status!=='pending')done.resolve();});
 await out.open(trusted,{reply_mode:'voice'});await out.seal(trusted,native);await first.promise;
 const pending=await out.readFinalized(trusted);assert.equal(pending.result.voice_status,'pending');assert.equal(pending.voice_chunks.length,1);assert.equal(pending.voice_chunks[0]!.final,false);
 const chunk=pending.voice_chunks[0]!;assert.equal((await out.getAudio(trusted,chunk.audio.ref)).sha256,chunk.audio.sha256);
 await out.ack(trusted,ack(chunk,1,'played'));assert.equal((await out.readFinalized(trusted)).result.delivery_status,'partial');
 release.resolve();await done.promise;const ready=await out.readFinalized(trusted);assert.equal(ready.result.voice_status,'ready');assert.equal(ready.voice_chunks[0]!.seq,2);assert.equal(ready.voice_chunks[0]!.final,true);assert.equal(calls,1);
 const cold=new OutputAuthority(storage);assert.deepEqual((await cold.readFinalized(trusted)).voice_chunks,ready.voice_chunks);await cold.ack(trusted,ack(chunk,2,'played'));assert.equal((await cold.readFinalized(trusted)).result.delivery_status,'played');
 await cold.cancel(trusted,1);await assert.rejects(cold.getAudio(trusted,chunk.audio.ref),/ACCESS_DENIED/);await out.close();
});
test('a failed partial remote stream replays persisted audio and rejects paid replay of the same reply',async t=>{
 const {storage,ctx}=await fixture(t),trusted={...ctx,target:{...ctx.target,output_modes:['voice']}},settled=Promise.withResolvers<void>();let calls=0;
 const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{throw Error('must stream');},stream:async function*(){calls++;yield wavFixture();throw Error('remote connection lost');}}});
 out.setVoiceOwner(async context=>{if((await out.readFinalized(context)).result.voice_status!=='pending')settled.resolve();});
 await out.open(trusted,{reply_mode:'voice'});await out.seal(trusted,native);await settled.promise;
 assert.equal((await out.readFinalized(trusted)).result.voice_status,'failed');assert.equal((await out.readFinalized(trusted)).voice_chunks.length,1);
 await out.seal(trusted,native);await assert.rejects(out.retryVoice(trusted,native),/PARTIAL_RETRY_UNSAFE/);assert.equal(calls,1);
 const cold=new OutputAuthority(storage);assert.equal((await cold.readFinalized(trusted)).voice_chunks.length,1);await out.close();
});
