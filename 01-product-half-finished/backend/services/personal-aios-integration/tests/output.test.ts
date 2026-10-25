import {fakeQwenConfiguration,fakeTtsConfiguration} from './speech-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputAuthority, type OutputContext, type OutputAck, type OpenReplyRequest, type RunReceiptRead, type ServiceReceipt } from '../src/output.ts';
import { PosixStorage } from '../src/storage.ts';
import { RawArchive } from '../src/archive.ts';
import { UnifiedIngress } from '../src/ingress.ts';
import { inspectWav, DashScopeTts } from '../src/tts.ts';
import { ContractError, digest, EVENT_SCHEMA } from '../src/contracts.ts';

const now = '2026-10-01T00:00:00.000Z';
async function fixture(t: test.TestContext, errand=false) {
  const path = await fs.mkdtemp(join(tmpdir(), 'paios-output-'));
  t.after(() => fs.rm(path, {recursive: true, force: true}));
  const storage = new PosixStorage(path);
  const d = await new UnifiedIngress(new RawArchive(storage, 4096, () => now)).accept({
    schema_version: EVENT_SCHEMA, event_id: 'event-one', device_id: 'mac-one', device_type: 'mac',
    captured_at: now, source: {channel: 'text'}, media_type: errand?'app_event':'text', mime: errand?'application/json':'text/plain;charset=utf-8',
    representation: 'uploaded_original', payload: Buffer.from(errand?JSON.stringify({kind:'errand_result',job_id:'job-one',answer:'done'}):'hello')},
  {principal_id: 'owner-one', device_id: 'mac-one', device_type: 'mac', consent_ref: 'consent-one',
    channel: 'text', submission: errand?'observation':'explicit_text'});
  const ctx: OutputContext = {principal_id: 'owner-one', run_id: 'run-one', session_id: 'session-one',
    tool_call_id: 'tool-one', d, target: {device_id: 'mac-one', device_type: 'mac', route_version: 'route-one', output_modes: ['text']}};
  return {path, storage, ctx, out: new OutputAuthority(storage, {chunkChars: 3})};
}
const native = {run_id: 'run-one', session_id: 'session-one', conversation_session_id: 'session-one', status: 'completed', output: '你好ABC😀'};
function ack(chunk: {output_id: string; reply_id: string; reply_epoch: number; target_device_id: string; route_version: string}, seq: number, status: OutputAck['status'] = 'rendered'): OutputAck {
  return {...chunk, highest_contiguous_seq: seq, status, observed_at: now};
}
// Existing post-synthesis assertions now wait for the source owner's explicit settlement.
// New voice-settlement.test.ts separately proves seal itself returns before synthesis.
const settlementOwners=new WeakMap<OutputAuthority,{waiters:Set<(error?:unknown,context?:OutputContext)=>void>}>();
async function settledSeal(out:OutputAuthority,ctx:OutputContext,run:Parameters<OutputAuthority['seal']>[1]) {
 let observer=settlementOwners.get(out);
 if(!observer){observer={waiters:new Set()};const current=observer;out.setVoiceOwner(async(context,error)=>{if(!error && (await out.readFinalized(context)).result.voice_status==='pending')return;for(const waiter of [...current.waiters])waiter(error,context);});settlementOwners.set(out,observer);}
 let finish!:(error?:unknown,context?:OutputContext)=>void;
 const settled=new Promise<void>((resolve,reject)=>{finish=(error,context)=>{if(context?.run_id===ctx.run_id){observer!.waiters.delete(finish);error?reject(error):resolve();}};});
 // Attach rejection before invoking source work, including a synchronous test fault.
 void settled.catch(()=>undefined);observer.waiters.add(finish);
 try {const result=await out.seal(ctx,run);if(result.voice_status==='pending')await settled;return (await out.readFinalized(ctx)).result;}
 finally {observer.waiters.delete(finish);}
}
async function settledVoiceChunks(out:OutputAuthority,ctx:OutputContext,run:Parameters<OutputAuthority['seal']>[1]) {
 await settledSeal(out,ctx,run);return out.voiceChunks(ctx,run);
}
test('real final text only, no arbitrary native delta or completed-without-open success', async t => {
  const {out, ctx} = await fixture(t);
  const opened = await out.open(ctx, {reply_mode: 'text', evidence_refs: [ctx.d.raw_ref]});
  assert.equal(opened.status, 'opened'); assert.equal(opened.phase, 'final_buffer');
  await assert.rejects(out.chunks(ctx, {...native, status: 'running', output: 'interim tool JSON'}), /NOT_TERMINAL/);
  const chunks = await out.chunks(ctx, native);
  assert.equal(chunks.map(c => c.text).join(''), native.output); assert.equal(chunks.at(-1)?.final, true);
  const result = await settledSeal(out, ctx, native);
  assert.equal(result.result_status, 'completed'); assert.equal(result.delivery_status, 'unknown');
  assert.deepEqual(result.evidence_refs, [ctx.d.raw_ref]);
  const withoutOpen = await settledSeal(out, {...ctx, run_id: 'run-two'}, {...native, run_id: 'run-two'});
  assert.equal(withoutOpen.result_status, 'failed'); assert.ok(withoutOpen.warnings.includes('OPEN_REQUIRED'));
});
test('trusted target and real receipt/evidence boundaries reject invented model identity, URLs and refs', async t => {
  const {out, ctx} = await fixture(t);
  ctx.target.output_modes.push('voice');
  for (const [tool, args, code] of [
    ['url', {reply_mode: 'text', target_aliases: ['https://evil.invalid']}, 'OUTPUT_TARGET_DENIED'],
    ['receipt', {reply_mode: 'text', receipt_refs: ['fake-saved']}, 'OUTPUT_RECEIPT_UNVERIFIED'],
    ['evidence', {reply_mode: 'text', evidence_refs: ['l5:' + '0'.repeat(64)]}, 'OUTPUT_EVIDENCE_DENIED'],
    ['voice', {reply_mode: 'voice'}, 'TTS_NOT_CONFIGURED'],
  ] as [string, OpenReplyRequest, string][]) {
    const receipt = await out.open({...ctx, tool_call_id: tool}, args);
    assert.equal(receipt.error_code, code); assert.equal(receipt.reply_id, null);
  }
  assert.equal((await settledSeal(out, ctx, native)).result_status, 'failed');
  await assert.rejects(out.open({...ctx, principal_id: 'impostor'}, {reply_mode: 'text'}), /PRINCIPAL_MISMATCH/);
});
test('silent final preserves authentic pending/failed receipts without fake execution or TTS', async t => {
  const {storage, ctx} = await fixture(t);
  const out = new OutputAuthority(storage, {resolveReceipt: async ref => ({receipt_ref: ref,
    status: 'pending_approval', kind: 'l3', summary: {receipt_ref: ref, status: 'pending_approval'}})});
  const open = await out.open(ctx, {reply_mode: 'none', receipt_refs: ['service-receipt']});
  assert.equal(open.status, 'silent'); assert.equal(open.reply_id, null);
  const result = await settledSeal(out, ctx, {...native, output: ''});
  assert.equal(result.result_status, 'completed'); assert.equal(result.reply_status, 'none');
  assert.equal(result.reply_text, ''); assert.deepEqual(result.l3_updates, [{receipt_ref: 'service-receipt', status: 'pending_approval'}]);
  assert.deepEqual(await out.chunks(ctx, {...native, output: ''}), []);
});
test('failed native, missing final text and mismatched run never produce successful text', async t => {
  const {out, ctx} = await fixture(t);
  await out.open(ctx, {reply_mode: 'text'});
  await assert.rejects(settledSeal(out, ctx, {...native, run_id: 'wrong'}), /BINDING_MISMATCH/);
  const failed = await settledSeal(out, ctx, {...native, status: 'failed'});
  assert.equal(failed.result_status, 'failed'); assert.equal(failed.reply_text, '');
  await assert.rejects(settledSeal(out, ctx, native), /REPLAY_CONFLICT/);
  const next = {...ctx, run_id: 'run-two'};
  await out.open(next, {reply_mode: 'text'});
  assert.equal((await settledSeal(out, next, {run_id: 'run-two', session_id:'session-one', conversation_session_id: 'session-one', status: 'completed'})).reply_status, 'failed');
});
test('stable tool replay, durable bounded epochs, competing instances and context conflict', async t => {
  const {out, storage, ctx} = await fixture(t);
  const restarted = new OutputAuthority(storage, {maxEpochs: 2});
  const first = await out.open(ctx, {reply_mode: 'text'});
  assert.deepEqual(await restarted.open(ctx, {reply_mode: 'text'}), first);
  await assert.rejects(restarted.open(ctx, {reply_mode: 'none'}), /REPLAY_CONFLICT/);
  const next = {...ctx, tool_call_id: 'tool-two'};
  const pair = await Promise.all([out.open(next, {reply_mode: 'text'}), restarted.open(next, {reply_mode: 'text'})]);
  assert.deepEqual(pair[0], pair[1]); assert.equal(pair[0].reply_epoch, 2);
  await assert.rejects(restarted.open({...ctx, tool_call_id: 'tool-three'}, {reply_mode: 'none'}), /EPOCH_LIMIT/);
  await assert.rejects(out.open({...ctx, target: {...ctx.target, device_id: 'other'}}, {reply_mode: 'text'}), /CONTEXT_CONFLICT/);
});
test('restart recovers only unrendered chunks, accepted is not rendered, duplicate ACK and bad source fail safely', async t => {
  const {out, storage, ctx} = await fixture(t);
  await out.open(ctx, {reply_mode: 'text'});
  const chunks = await out.chunks(ctx, native);
  const first = chunks[0]!;
  await out.ack(ctx, ack(first, 1, 'accepted'));
  assert.equal((await settledSeal(out, ctx, native)).delivery_status, 'accepted');
  assert.equal((await out.chunks(ctx, native)).length, chunks.length);
  const receipt = await out.ack(ctx, ack(first, 1));
  const restarted = new OutputAuthority(storage);
  assert.deepEqual(await restarted.ack(ctx, ack(first, 1)), receipt);
  assert.equal((await restarted.chunks(ctx, native))[0]?.seq, 2);
  await assert.rejects(restarted.ack(ctx, {...ack(first, 2), target_device_id: 'evil'}), /BINDING_MISMATCH/);
  await assert.rejects(restarted.ack(ctx, {...ack(first, 2), reply_epoch: 0}), /OUTPUT_ACK_INVALID/);
  await out.ack(ctx, ack(first, chunks.length));
  assert.equal((await settledSeal(out, ctx, native)).delivery_status, 'rendered');
  assert.deepEqual(await restarted.chunks(ctx, native), []);
});
test('OUT rejects malformed runtime ACK before any journal write or delivery watermark', async t => {
  const {out, storage, ctx} = await fixture(t);
  await out.open(ctx, {reply_mode: 'text'});
  const first = (await out.chunks(ctx, native))[0]!;
  const valid = ack(first, 1);
  let writes = 0;
  const publish = storage.publish.bind(storage);
  storage.publish = async (...args) => {writes++; return publish(...args);};
  const malformed: unknown[] = [null, undefined, true, [], {}, new Date(),
    {...valid, output_id: null}, {...valid, reply_id: 12}, {...valid, target_device_id: ''},
    {...valid, route_version: {}}, {...valid, reply_epoch: 0}, {...valid, reply_epoch: true},
    {...valid, reply_epoch: 1.5}, {...valid, reply_epoch: Number.MAX_SAFE_INTEGER + 1},
    {...valid, highest_contiguous_seq: 0}, {...valid, highest_contiguous_seq: 1.5},
    {...valid, status: 'complete'}, {...valid, observed_at: 'yesterday'}, {...valid, extra: NaN}];
  for (const input of malformed) await assert.rejects(out.ack(ctx, input),
    error => error instanceof ContractError && error.status === 400);
  assert.equal(writes, 0);
  assert.equal((await out.readSealedText(ctx)).result.delivery_status, 'unknown');
  assert.equal((await out.textDelivery(ctx)).rendered_text_through_seq, 0);
});
test('ACK snapshot preserves original metadata, digest and restart retry across an awaited read', async t => {
  const {out, storage, ctx} = await fixture(t);
  await out.open(ctx, {reply_mode: 'text'});
  const first = (await out.chunks(ctx, native))[0]!;
  const input = {...ack(first, 1), trace: {value: 'original'}};
  const original = structuredClone(input);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const read = storage.read.bind(storage); let held = true;
  storage.read = async (...args) => {
    if (held && args[0] === 'output-journal') {held = false; entered.resolve(); await release.promise;}
    return read(...args);
  };
  const writing = out.ack(ctx, input); await entered.promise;
  input.reply_id = 'changed'; input.highest_contiguous_seq = 2; input.trace.value = 'changed';
  release.resolve(); const receipt = await writing;
  assert.deepEqual(receipt, {...original, receipt_ref: `out-ack:${digest(original)}`});
  assert.deepEqual(await new OutputAuthority(storage).ack(ctx, original), receipt);
  assert.equal((await out.textDelivery(ctx)).rendered_text_through_seq, 1);
});
test('cancel fences old epoch and does not pretend to cancel native execution or device playback', async t => {
  const {out, ctx} = await fixture(t);
  const opened = await out.open(ctx, {reply_mode: 'text'});
  const chunks = await out.chunks(ctx, native);
  const receipt = await out.cancel(ctx, opened.reply_epoch);
  assert.deepEqual(await out.cancel(ctx, opened.reply_epoch), receipt);
  assert.deepEqual(await out.chunks(ctx, native), []);
  assert.equal((await settledSeal(out, ctx, native)).run_status, 'completed');
  assert.equal((await settledSeal(out, ctx, native)).result_status, 'interrupted');
  await assert.rejects(out.ack(ctx, ack(chunks[0]!, 1)), /OLD_EPOCH/);
});
test('storage publication failure gives no receipt and exact retry recovers one durable OPEN', async t => {
  const {storage, ctx} = await fixture(t);
  let fail = true;
  const out = new OutputAuthority({removePending: k => storage.removePending(k), read: (n,k) => storage.read(n,k), list: n => storage.list(n),
    publish: async (n,k,b) => {if (n === 'output-journal' && fail) {fail = false; throw new Error('DISK_FAILURE');} return storage.publish(n,k,b);}});
  await assert.rejects(out.open(ctx, {reply_mode: 'text'}), /DISK_FAILURE/);
  const receipt = await out.open(ctx, {reply_mode: 'text'});
  assert.equal(receipt.reply_epoch, 1);
  assert.deepEqual(await out.open(ctx, {reply_mode: 'text'}), receipt);
});
for (const replyMode of ['text', 'none'] as const) for (const valid of [true, false])
test(`OPEN snapshots validated arrays across awaits (${replyMode}, ${valid ? 'valid' : 'rejected'} input)`, async t => {
  const {storage, ctx} = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const config = {resolveReceipt: async (ref: string): Promise<ServiceReceipt | null> => {
    calls.push(ref); entered.resolve(); await release.promise;
    return ref === 'verified-service' ? {receipt_ref: ref, status: 'committed', kind: 'l3', summary: {status: 'committed'}} : null;
  }};
  const out = new OutputAuthority(storage, config);
  const args: OpenReplyRequest = {reply_mode: replyMode, target_aliases: ['source'], output_modes: replyMode === 'none' ? [] : ['text'],
    receipt_refs: ['verified-service'], evidence_refs: [valid ? ctx.d.raw_ref : 'denied-evidence']};
  const original = structuredClone(args);
  const opening = out.open(ctx, args);
  await entered.promise;
  args.target_aliases![0] = 'untrusted-target'; args.output_modes![0] = 'voice';
  if (valid) {args.receipt_refs!.push('forged-service'); args.evidence_refs!.push('denied-evidence');}
  else args.evidence_refs!.length = 0;
  release.resolve();
  const receipt = await opening;
  assert.equal(receipt.status, valid ? replyMode === 'none' ? 'silent' : 'opened' : 'rejected');
  assert.equal(receipt.error_code, valid ? null : 'OUTPUT_EVIDENCE_DENIED');
  assert.deepEqual(calls, ['verified-service']);
  assert.deepEqual(await new OutputAuthority(storage, config).open(ctx, original), receipt);
  assert.deepEqual(calls, ['verified-service']);
  await assert.rejects(out.open(ctx, args), /OUTPUT_REPLAY_CONFLICT/);
  const result = await settledSeal(out, ctx, native);
  assert.equal(result.reply_status, valid ? replyMode === 'none' ? 'none' : 'complete' : 'failed');
  assert.deepEqual(result.evidence_refs, valid ? [ctx.d.raw_ref] : []);
  if (valid && replyMode === 'text') {
    const chunk = (await out.chunks(ctx, native))[0]!;
    assert.equal(chunk.target_device_id, ctx.target.device_id);
    await out.ack(ctx, ack(chunk, 1));
  } else assert.deepEqual(await out.chunks(ctx, native), []);
});
test('old cancelled plan is replaced by a new durable epoch before final buffering', async t => {
  const {out, ctx} = await fixture(t);
  const first = await out.open(ctx, {reply_mode: 'text'});
  await out.cancel(ctx, first.reply_epoch);
  const second = await out.open({...ctx, tool_call_id: 'tool-two'}, {reply_mode: 'text'});
  assert.equal(second.reply_epoch, 2);
  const chunks = await out.chunks(ctx, native);
  assert.equal(chunks[0]?.reply_epoch, 2);
  await assert.rejects(out.cancel(ctx, 0), /OLD_EPOCH/);
});
test('independent Node processes converge on a single epoch for the same trusted tool call', async t => {
  const {path, ctx} = await fixture(t);
  const {spawn} = await import('node:child_process');
  const contextPath = join(path, 'context.json');
  await fs.writeFile(contextPath, JSON.stringify(ctx));
  const script = `import {readFile} from 'node:fs/promises';
    import {OutputAuthority} from ${JSON.stringify(new URL('../src/output.ts', import.meta.url).href)};
    import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts', import.meta.url).href)};
    const ctx=JSON.parse(await readFile(process.argv[1],'utf8'));
    console.log(JSON.stringify(await new OutputAuthority(new PosixStorage(process.argv[2])).open(ctx,{reply_mode:'text'})));`;
  const child = () => new Promise<string>((resolve,reject) => {
    const p = spawn(process.execPath, ['--input-type=module','-e',script,contextPath,path]);
    let stdout = ''; let stderr = '';
    p.stdout.on('data', b => {stdout += b;}); p.stderr.on('data', b => {stderr += b;});
    p.on('error', reject); p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  const [a,b] = await Promise.all([child(),child()]);
  assert.deepEqual(JSON.parse(a!), JSON.parse(b!)); assert.equal(JSON.parse(a!).reply_epoch, 1);
});

test('OPEN rejects model identity fields and mode contradictions; plain null-prototype JSON is accepted', async t => {
  const {out, ctx} = await fixture(t);
  const forged = {reply_mode: 'text', run_id: 'different'} as OpenReplyRequest;
  assert.equal((await out.open(ctx, forged)).error_code, 'OUTPUT_ARGUMENT_UNSUPPORTED');
  const modes = await out.open({...ctx, tool_call_id: 'two'}, {reply_mode: 'none', output_modes: ['text']});
  assert.equal(modes.error_code, 'OUTPUT_MODE_DENIED');
  const empty = await out.open({...ctx, tool_call_id: 'three'}, {reply_mode: 'text', output_modes: []});
  assert.equal(empty.error_code, 'OUTPUT_MODE_DENIED');
  const plain = Object.assign(Object.create(null), {reply_mode: 'text'});
  assert.equal((await out.open({...ctx, tool_call_id: 'four'}, plain)).status, 'opened');
  await assert.rejects(out.open({...ctx, tool_call_id: 'five'}, {reply_mode: 'text', evidence_refs: [2]} as unknown as OpenReplyRequest), /INVALID_OPEN_REPLY/);
});

function wavFixture() {
  const b = Buffer.alloc(244); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(200, 40); return inspectWav(b);
}
for (const mode of ['voice', 'text_and_voice'] as const) {
  test(`text-only registered route produces ${mode} requests as text before TTS admission, including replay`, async t => {
    const {storage, ctx} = await fixture(t);
    let syntheses = 0, streams = 0, notifications = 0;
    const config = {tts: {
      synthesize: async () => {syntheses++; return wavFixture();},
      stream: async function* () {streams++; yield wavFixture();},
    }};
    const out = new OutputAuthority(storage, config);
    out.setVoiceOwner(async () => {notifications++;}, 1);
    const request = {reply_mode: mode, output_modes: mode === 'voice' ? ['voice'] : ['text','voice']};
    const opened = await out.open(ctx, request);
    assert.equal(opened.status, 'opened'); assert.equal(opened.reply_mode, 'text');
    assert.deepEqual(opened.authorized_targets, ['mac-one']);
    for (const owner of [out, new OutputAuthority(storage, config)]) {
      assert.deepEqual(await owner.open(ctx, request), opened);
      const result = await owner.seal(ctx, native);
      assert.equal(result.reply_mode, 'text'); assert.equal(result.voice_status, 'none');
      assert.equal(result.result_status, 'completed');
      assert.deepEqual(result.output_plan, [{target_device_id: 'mac-one', device_type: 'mac',
        output_modes: ['text'], route_version: 'route-one'}]);
      assert.equal((await owner.chunks(ctx, native)).map(c => c.text).join(''), native.output);
      assert.deepEqual(await owner.voiceChunks(ctx, native), []);
      await assert.rejects(owner.retryVoice(ctx, native), /OUTPUT_VOICE_RETRY_NOT_SAFE/);
      await owner.close();
    }
    assert.deepEqual([syntheses, streams, notifications], [0, 0, 0]);
    assert.deepEqual(await storage.list('derived-audio'), []);
    for (const key of await storage.list('output-journal')) {
      const entry = JSON.parse(Buffer.from(await storage.read('output-journal', key)).toString());
      assert.equal(entry.operation.startsWith('voice-'), false, 'no audio admission, claim, or budget refusal');
    }
    await assert.rejects(out.open(ctx, {reply_mode: 'text'}), /REPLAY_CONFLICT/);
  });
}
for (const mode of ['voice', 'text_and_voice'] as const) {
  test(`cancelled ${mode} finalized notifications cannot offer old audio after restart`, async t => {
    const {path, storage, ctx} = await fixture(t);
    const trusted = {...ctx, target: {...ctx.target, output_modes: ['text','voice']}};
    let calls = 0;
    const config = {tts: {synthesize: async () => {calls++; return wavFixture();}}};
    const out = new OutputAuthority(storage, config);
    await out.open(trusted, {reply_mode: mode});
    await settledSeal(out, trusted, native);
    const ready = await out.readFinalized(trusted);
    assert.equal(ready.voice_chunks.length, 1);
    const voice = ready.voice_chunks[0]!;
    await out.cancel(trusted, voice.reply_epoch);
    assert.deepEqual(await settledVoiceChunks(out, trusted, native), []);
    await assert.rejects(out.getAudio(trusted, voice.audio.ref), /ACCESS_DENIED/);
    await assert.rejects(out.ack(trusted, {...ack(voice, 1), status: 'played'}), /OLD_EPOCH/);
    await assert.rejects(out.readSealedText(trusted), /OLD_EPOCH/);
    for (const owner of [out, new OutputAuthority(storage, config)]) {
      const cancelled = await owner.readFinalized(trusted);
      assert.equal(cancelled.result.reply_phase, 'interrupted');
      assert.equal(cancelled.result.run_status, 'completed');
      assert.equal(cancelled.result.reply_id, ready.result.reply_id);
      assert.deepEqual(cancelled.result.output_plan, ready.result.output_plan);
      assert.deepEqual(cancelled.chunks, []);
      assert.deepEqual(cancelled.voice_chunks, []);
    }
    const contextPath = join(path, 'cancelled-voice-context.json');
    await fs.writeFile(contextPath, JSON.stringify(trusted), {mode: 0o600});
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const reader = `import {readFile} from 'node:fs/promises';
      import {OutputAuthority} from ${JSON.stringify(new URL('../src/output.ts', import.meta.url).href)};
      import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts', import.meta.url).href)};
      const ctx=JSON.parse(await readFile(process.argv[1],'utf8'));
      console.log(JSON.stringify(await new OutputAuthority(new PosixStorage(process.argv[2])).readFinalized(ctx)));`;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module','-e',reader,contextPath,path], {timeout: 10000});
    const restored = JSON.parse(child.stdout);
    assert.equal(restored.result.reply_phase, 'interrupted');
    assert.equal(restored.result.reply_id, ready.result.reply_id);
    assert.deepEqual(restored.chunks, []);
    assert.deepEqual(restored.voice_chunks, []);
    assert.equal(calls, 1);
  });
}
test('voice readiness is durable, source-bound and separate from text rendered and voice played ACK', async t => {
  const {storage, ctx} = await fixture(t); let calls = 0;
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['text','voice']}};
  const out = new OutputAuthority(storage, {tts: {synthesize: async text => {calls++; assert.equal(text, native.output); return wavFixture();}}});
  await out.open(trusted, {reply_mode: 'text_and_voice'});
  const result = await settledSeal(out, trusted, native);
  assert.equal(result.voice_status, 'ready'); assert.equal(result.delivery_status, 'unknown');
  const voice = (await settledVoiceChunks(out, trusted, native))[0]!;
  const text = await out.chunks(trusted, native);
  assert.equal(voice.final, true); assert.equal(voice.text_range.end, Array.from(native.output).length);
  assert.equal((await out.getAudio(trusted, voice.audio.ref)).sha256, voice.audio.sha256);
  const restarted = new OutputAuthority(storage, {tts: {synthesize: async () => {throw new Error('must not rerun');}}});
  assert.equal((await settledVoiceChunks(restarted, trusted, native))[0]?.audio.ref, voice.audio.ref); assert.equal(calls, 1);
  await out.ack(trusted, ack(text[0]!, text.length));
  assert.equal((await settledSeal(out, trusted, native)).delivery_status, 'partial');
  await assert.rejects(out.ack(trusted, ack(voice, 1)), /CHANNEL_MISMATCH/);
  await out.ack(trusted, {...ack(voice, 1), status: 'played'});
  assert.equal((await settledSeal(out, trusted, native)).delivery_status, 'played');
  assert.deepEqual(await settledVoiceChunks(restarted, trusted, native), []);
  await assert.rejects(out.getAudio({...trusted, run_id: 'other'}, voice.audio.ref), /ACCESS_DENIED/);
  await out.cancel(trusted, voice.reply_epoch);
  await assert.rejects(out.getAudio(trusted, voice.audio.ref), /ACCESS_DENIED/);
  await assert.rejects(out.ack(trusted, {...ack(voice, 1), status: 'played'}), /OLD_EPOCH/);
});
test('known TTS failure retains text complete and permits explicit safe retry without native rerun', async t => {
  const {storage, ctx} = await fixture(t); let calls = 0;
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['text','voice']}};
  const out = new OutputAuthority(storage, {tts: {synthesize: async () => {calls++; if (calls === 1) throw new Error('provider down'); return wavFixture();}}});
  await out.open(trusted, {reply_mode: 'text_and_voice'});
  const result = await settledSeal(out, trusted, native);
  assert.equal(result.voice_status, 'failed'); assert.equal(result.reply_status, 'complete'); assert.equal(result.result_status, 'completed');
  assert.ok((await out.chunks(trusted, native)).length > 0);
  await settledSeal(out, trusted, native); assert.equal(calls, 1);
  assert.equal((await out.retryVoice(trusted, native)).voice_status, 'ready'); assert.equal(calls, 2);
  await assert.rejects(out.retryVoice(trusted, native), /RETRY_NOT_SAFE/);
});
for (const variant of [{artifact: true, owner: 'restarted'}, {artifact: false, owner: 'restarted'}, {artifact: false, owner: 'same'}] as const) {
  test(`abandoned synth claim (${variant.owner}, artifact ${variant.artifact}): existing audio is adopted, otherwise explicit retry authorizes one fenced remote request`, async t => {
    const {storage, ctx} = await fixture(t); let calls = 0;
    const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
    let failAudio = true;
    const faulty = {...storage, read: storage.read.bind(storage), list: storage.list.bind(storage), removePending: storage.removePending.bind(storage),
      publish: async (n: string,k: string,b: Uint8Array) => {if (n === 'derived-audio' && failAudio) {failAudio = false; throw new Error('DISK_FULL');} return storage.publish(n,k,b);}};
    const out = new OutputAuthority(faulty, {tts: {synthesize: async () => {calls++; return wavFixture();}}});
    await out.open(trusted, {reply_mode: 'voice'});
    await assert.rejects(settledSeal(out, trusted, native), /DISK_FULL/);
    const owner = variant.owner === 'same' ? out : new OutputAuthority(storage, {tts: {synthesize: async () => {calls++; return wavFixture();}}});
    const unknown = (await owner.readFinalized(trusted)).result;
    assert.equal(unknown.voice_status, 'reconcile_required'); assert.equal(calls, 1);
    assert.equal(unknown.reply_status, 'complete'); assert.equal(unknown.reply_phase, 'sealed'); assert.equal(unknown.reply_text, native.output);
    assert.deepEqual(unknown.output_plan, [{target_device_id:trusted.target.device_id,device_type:trusted.target.device_type,route_version:trusted.target.route_version,output_modes:['voice']}]);
    const scope = digest({principal_id: trusted.principal_id, run_id: trusted.run_id});
    const first = digest({scope, epoch: 1, attempt: 1});
    // The generated artifact may already exist under the abandoned claim's audioKey: adopt it, never regenerate.
    if (variant.artifact) await storage.publish('derived-audio', first, wavFixture().bytes);
    if (!variant.artifact) {assert.equal((await settledSeal(owner, trusted, native)).voice_status, 'reconcile_required'); assert.equal(calls, 1); await owner.retryVoice(trusted, native);}
    assert.equal((await settledSeal(owner, trusted, native)).voice_status, 'ready'); assert.equal(calls, variant.artifact ? 1 : 2);
    const chunk = (await owner.voiceChunks(trusted, native))[0]!;
    assert.equal(chunk.audio.ref, `audio:${variant.artifact ? first : digest({scope, epoch: 1, attempt: 2})}`);
    assert.equal((await owner.getAudio(trusted, chunk.audio.ref)).sha256, chunk.audio.sha256);
    assert.equal((await settledSeal(owner, trusted, native)).voice_status, 'ready');
    await assert.rejects(owner.retryVoice(trusted, native), /RETRY_NOT_SAFE/); assert.equal(calls, variant.artifact ? 1 : 2);
  });
}
// A real child process writes the durable TTS claim, then blocks inside synthesis (SIGKILL or stdin release).
async function claimingChild(t: test.TestContext, path: string, ctx: OutputContext) {
  const {spawn} = await import('node:child_process');
  const contextPath = join(path, 'voice-claim-context.json');
  await fs.writeFile(contextPath, JSON.stringify(ctx), {mode: 0o600});
  const script = `import {readFile} from 'node:fs/promises';
    import {OutputAuthority} from ${JSON.stringify(new URL('../src/output.ts', import.meta.url).href)};
    import {PosixStorage} from ${JSON.stringify(new URL('../src/storage.ts', import.meta.url).href)};
    import {inspectWav} from ${JSON.stringify(new URL('../src/tts.ts', import.meta.url).href)};
    const ctx=JSON.parse(await readFile(process.argv[1],'utf8'));
    const b=Buffer.alloc(244);b.write('RIFF');b.writeUInt32LE(236,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);
    b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(200,40);
    const gate=new Promise(resolve=>process.stdin.once('data',resolve));
    const out=new OutputAuthority(new PosixStorage(process.argv[2]),{tts:{synthesize:async()=>{console.log('SYNTHESIZING');await gate;return inspectWav(b);}}});
    const settled=new Promise(resolve=>out.setVoiceOwner(async(_ctx,error)=>resolve(error)));
    await out.open(ctx,{reply_mode:'voice'});await out.seal(ctx,JSON.parse(process.argv[3]));
    const error=await settled;console.log('SETTLED:'+(error?.code??error?.message??'ok'));process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module','-e',script,contextPath,path,JSON.stringify(native)], {stdio: ['pipe','pipe','pipe']});
  let stdout = '', stderr = '';
  const synthesizing = Promise.withResolvers<void>();
  const exited = new Promise<number|null>(resolve => child.on('close', code => resolve(code)));
  child.stdout.on('data', bytes => {stdout += bytes; if (stdout.includes('SYNTHESIZING')) synthesizing.resolve();});
  child.stderr.on('data', bytes => {stderr += bytes;});
  void exited.then(() => synthesizing.reject(new Error(`child exited before claim: ${stderr}`)));
  t.after(() => {child.kill('SIGKILL');});
  await synthesizing.promise;
  return {child, exited, stdout: () => stdout};
}
const voiceEntries = async (out: OutputAuthority, ctx: OutputContext) =>
  ((await Reflect.get(out, 'state').call(out, ctx)) as {entries: {operation: string; voice?: {attempt: number; owner: string; status: string}}[]}).entries.filter(entry => entry.voice);
test('TTS claim written before a real process crash: restart requires explicit retry before one fenced remote request', async t => {
  const {path, storage, ctx} = await fixture(t);
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
  const crashed = await claimingChild(t, path, trusted);
  crashed.child.kill('SIGKILL'); await crashed.exited;
  assert.deepEqual(await storage.list('derived-audio'), []);
  let calls = 0; const tts = {synthesize: async () => {calls++; return wavFixture();}};
  const restarted = new OutputAuthority(storage, {tts});
  const before = await voiceEntries(restarted, trusted);
  assert.deepEqual(before.map(entry => [entry.operation, entry.voice!.status]), [['voice-claim:1', 'claimed']]);
  assert.equal((await restarted.readFinalized(trusted)).result.voice_status, 'reconcile_required');
  assert.equal((await settledSeal(restarted, trusted, native)).voice_status, 'reconcile_required'); assert.equal(calls, 0);
  assert.equal((await restarted.retryVoice(trusted, native)).voice_status, 'ready'); assert.equal(calls, 1);
  const after = await voiceEntries(restarted, trusted);
  assert.deepEqual(after.map(entry => [entry.operation, entry.voice!.status, entry.voice!.attempt]),
    [['voice-claim:1', 'claimed', 1], ['voice-claim:2', 'claimed', 2], ['voice-chunk:2:1', 'claimed', 2], ['voice-finish:2', 'ready', 2]]);
  assert.notEqual(after[1]!.voice!.owner, before[0]!.voice!.owner);
  const chunk = (await restarted.voiceChunks(trusted, native))[0]!;
  assert.equal((await restarted.getAudio(trusted, chunk.audio.ref)).sha256, chunk.audio.sha256);
  // Generation is done: further reads, a cold owner and an explicit retry never synthesize again.
  assert.equal((await settledSeal(new OutputAuthority(storage, {tts}), trusted, native)).voice_status, 'ready');
  await assert.rejects(restarted.retryVoice(trusted, native), /RETRY_NOT_SAFE/); assert.equal(calls, 1);
  // Playback dedupe is separate: the voice output id is per reply, not per generation attempt.
  await restarted.ack(trusted, {...ack(chunk, 1), status: 'played'});
  assert.deepEqual(await restarted.voiceChunks(trusted, native), []);
});
test('a superseded claim owner that outlives the takeover cannot settle the voice (fenced)', async t => {
  const {path, storage, ctx} = await fixture(t);
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
  const stale = await claimingChild(t, path, trusted);
  let calls = 0; const recovered = new OutputAuthority(storage, {tts: {synthesize: async () => {calls++; return wavFixture();}}});
  // Not live in this process: recoverable through the explicit retry entry, which takes over once.
  assert.equal((await recovered.retryVoice(trusted, native)).voice_status, 'ready'); assert.equal(calls, 1);
  const ready = (await recovered.voiceChunks(trusted, native))[0]!;
  stale.child.stdin.write('release\n'); assert.equal(await stale.exited, 0);
  assert.match(stale.stdout(), /SETTLED:OUTPUT_VOICE_CLAIM_SUPERSEDED/);
  const entries = await voiceEntries(recovered, trusted);
  assert.equal(entries.some(entry => entry.operation === 'voice-finish:1'), false);
  assert.deepEqual((await recovered.voiceChunks(trusted, native))[0], ready); assert.equal(calls, 1);
});
test('a live TTS claim in this process is never stolen; retry joins it and synthesis runs once', async t => {
  const {storage, ctx} = await fixture(t);
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let calls = 0;
  const tts = {synthesize: async () => {calls++; entered.resolve(); await release.promise; return wavFixture();}};
  const out = new OutputAuthority(storage, {tts}); t.after(async () => {release.resolve(); await out.close();});
  await out.open(trusted, {reply_mode: 'voice'});
  assert.equal((await out.seal(trusted, native)).voice_status, 'pending'); await entered.promise;
  const joined = out.retryVoice(trusted, native);
  const sibling = new OutputAuthority(storage, {tts}); t.after(() => sibling.close());
  assert.equal((await settledSeal(sibling, trusted, native)).voice_status, 'reconcile_required');
  await assert.rejects(sibling.retryVoice(trusted, native), /RETRY_NOT_SAFE/);
  assert.equal(calls, 1); assert.equal((await voiceEntries(out, trusted)).length, 1);
  release.resolve(); assert.equal((await joined).voice_status, 'ready'); assert.equal(calls, 1);
  assert.deepEqual((await voiceEntries(out, trusted)).map(entry => entry.operation), ['voice-claim:1', 'voice-chunk:1:1', 'voice-finish:1']);
});
test('pure voice synthesis failure preserves source reply; native failure remains failed', async t => {
  const {storage, ctx} = await fixture(t); let calls = 0;
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
  const out = new OutputAuthority(storage, {tts: {synthesize: async () => {calls++; throw new Error('failed');}}});
  await out.open(trusted, {reply_mode: 'voice'});
  const result = await settledSeal(out, trusted, native);
  assert.equal(result.result_status, 'completed'); assert.equal(result.reply_status, 'complete'); assert.equal(result.reply_phase, 'sealed');
  assert.equal(result.reply_text, native.output); assert.equal(result.voice_status, 'failed'); assert.equal(result.delivery_status, 'unknown');
  assert.deepEqual(await out.chunks(trusted, native), []); assert.deepEqual(await settledVoiceChunks(out, trusted, native), []);
  const next = {...trusted, run_id: 'next'};
  await out.open(next, {reply_mode: 'voice'});
  assert.equal((await settledSeal(out, next, {...native, run_id: 'next', status: 'failed'})).voice_error, 'NATIVE_FINAL_NOT_AVAILABLE');
  assert.equal(calls, 1);
});
test('OUT Qwen transport WAV integration preserves L5 original and never claims playback', {}, async t => {
  const {storage, ctx} = await fixture(t);
  const originals = await storage.list('objects');
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
  const tts = new DashScopeTts(fakeQwenConfiguration(), fakeTtsConfiguration);
  const out = new OutputAuthority(storage, {tts}); t.after(async()=>{await out.close(); await tts.close();});
  await out.open(trusted, {reply_mode: 'voice'});
  const final = {...native, output: '这是统一输出服务生成的真实语音文件。'};
  const chunk = (await settledVoiceChunks(out, trusted, final))[0]!;
  const audio = await out.getAudio(trusted, chunk.audio.ref);
  assert.ok(audio.duration_ms > 0); assert.equal(audio.sample_rate, 22050);
  assert.deepEqual(await storage.list('objects'), originals);
  assert.equal((await settledSeal(out, trusted, final)).delivery_status, 'unknown');
});
test('competing OUT authorities claim one synthesis; interim has no TTS invocation and invalid voice seq is rejected', async t => {
  const {storage, ctx} = await fixture(t);
  const trusted = {...ctx, target: {...ctx.target, output_modes: ['voice']}};
  let calls = 0; let release!: () => void; let started!: () => void;
  const start = new Promise<void>(resolve => {started = resolve;});
  const finish = new Promise<void>(resolve => {release = resolve;});
  const tts = {synthesize: async () => {calls++; started(); await finish; return wavFixture();}};
  const one = new OutputAuthority(storage, {tts}); const two = new OutputAuthority(storage, {tts});
  await one.open(trusted, {reply_mode: 'voice'});
  await assert.rejects(settledSeal(one, trusted, {...native, status: 'running', output: '{"tool":"interim"}'}), /NOT_TERMINAL/);
  assert.equal(calls, 0);
  const pending = settledSeal(one, trusted, native); await start;
  assert.equal((await settledSeal(two, trusted, native)).voice_status, 'reconcile_required'); assert.equal(calls, 1);
  release(); assert.equal((await pending).voice_status, 'ready');
  const voice = (await settledVoiceChunks(two, trusted, native))[0]!;
  await assert.rejects(two.ack(trusted, {...ack(voice, 2), status: 'played'}), /SEQUENCE_INVALID/);
  assert.equal(calls, 1);
});
test('OUT joins owned TTS, cancels only the original epoch and fences a late successful provider result', async t => {
  const {storage, ctx} = await fixture(t);
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const signals: AbortSignal[] = []; let calls = 0;
  const out = new OutputAuthority(storage, {tts: {synthesize: async (_text, _id, signal) => {
    const index = calls++; signals.push(signal!); entered[index]!.resolve();
    await release[index]!.promise; return wavFixture();
  }}});
  const contexts = [0,1,2].map(index => ({...ctx, run_id: 'owned-' + index,
    target: {...ctx.target, output_modes: ['text','voice']}}));
  const runs = contexts.map(context => ({...native, run_id: context.run_id}));
  for (const context of contexts) await out.open(context, {reply_mode: 'text_and_voice'});
  const first = settledSeal(out, contexts[0]!, runs[0]!); await entered[0]!.promise;
  const duplicate = settledSeal(out, contexts[0]!, runs[0]!);
  const second = settledSeal(out, contexts[1]!, runs[1]!); await entered[1]!.promise;
  const cancelled = await out.cancel(contexts[0]!, 1);
  assert.deepEqual(await out.cancel(contexts[0]!, 1), cancelled);
  assert.equal(signals[0]!.aborted, true); assert.equal(signals[1]!.aborted, false);
  release[0]!.resolve(); release[1]!.resolve();
  assert.equal((await first).reply_phase, 'interrupted'); await duplicate;
  assert.equal((await second).voice_status, 'ready'); assert.equal(calls, 2);
  assert.deepEqual(await settledVoiceChunks(out, contexts[0]!, runs[0]!), []);
  const third = settledSeal(out, contexts[2]!, runs[2]!); await entered[2]!.promise;
  const closing = out.close(); assert.equal(out.close(), closing);
  assert.equal(signals[2]!.aborted, true); let joined = false;
  void closing.then(() => {joined = true;}); await Promise.resolve(); assert.equal(joined, false);
  release[2]!.resolve(); await third; await closing;
  assert.equal(joined, true); assert.equal(calls, 3);
  const retained = await out.readFinalized(contexts[2]!);
  assert.equal(retained.result.voice_error, 'TTS_SYNTHESIS_CANCELLED');
  assert.equal(retained.chunks.map(chunk => chunk.text).join(''), native.output);
  const restarted = new OutputAuthority(storage, {tts: {synthesize: async () => wavFixture()}});
  assert.equal((await restarted.retryVoice(contexts[2]!, runs[2]!)).voice_status, 'ready');
});
// E15 source-port tests use explicit fixture projections. They do not assert PostgreSQL commit/run-binding acceptance.
function readSources(receipts: ServiceReceipt[]): RunReceiptRead {
  return {sources: (['l3','action','l2'] as const).map(source => ({source, status: 'complete', error: null,
    receipts: receipts.filter(receipt => receipt.kind === source)}))};
}
function committedProjection() {
  return {receipt_ref: 'l3:actual-fixture', status: 'committed', kind: 'l3' as const,
    summary: {receipt_ref: 'l3:actual-fixture', status: 'committed', command_id: 'command-one', assertion_id: 'assertion-one', version: 1}};
}
test('actual run receipt projection survives no OPEN plus native failure and rejected OPEN', async t => {
  const {storage, ctx} = await fixture(t); let reads = 0;
  const receipt = committedProjection();
  const out = new OutputAuthority(storage, {listRunReceipts: async received => {
    reads++; assert.equal(received.principal_id, ctx.principal_id); assert.equal(received.run_id, ctx.run_id); return readSources([receipt]);
  }});
  const failed = await settledSeal(out, ctx, {...native, status: 'failed', output: '{"l3_updates":[],"saved":false}'});
  assert.deepEqual(failed.l3_updates, [receipt.summary]); assert.equal(failed.receipt_status, 'complete');
  assert.equal(failed.run_status, 'failed'); assert.equal(failed.reply_status, 'failed'); assert.equal(failed.delivery_status, 'unknown');
  const next = {...ctx, run_id: 'next'};
  const rejectedOut = new OutputAuthority(storage, {listRunReceipts: async () => readSources([receipt])});
  await rejectedOut.open(next, {reply_mode: 'text', target_aliases: ['model-arbitrary-device']});
  const rejected = await rejectedOut.seal(next, {...native, run_id: 'next'});
  assert.deepEqual(rejected.l3_updates, [receipt.summary]); assert.equal(rejected.result_status, 'failed');
  assert.equal(reads, 1);
});
test('silent/no-ref OPEN loads actual run receipts of each kind and deduplicates all OPEN epochs/source refs', async t => {
  const {storage, ctx} = await fixture(t);
  const receipt = committedProjection();
  const action = {receipt_ref: 'action:fixture', status: 'failed', kind: 'action' as const, summary: {receipt_ref: 'action:fixture', status: 'failed'}};
  const l2 = {receipt_ref: 'l2:fixture', status: 'committed', kind: 'l2' as const, summary: {receipt_ref: 'l2:fixture', status: 'committed'}};
  const out = new OutputAuthority(storage, {resolveReceipt: async () => receipt, listRunReceipts: async () => readSources([receipt,receipt,action,l2])});
  await out.open(ctx, {reply_mode: 'text', receipt_refs: [receipt.receipt_ref,receipt.receipt_ref]});
  await out.open({...ctx, tool_call_id: 'tool-two'}, {reply_mode: 'none'});
  const result = await settledSeal(out, ctx, {...native, output: ''});
  assert.equal(result.reply_status, 'none'); assert.equal(result.result_status, 'completed'); assert.equal(result.receipt_status, 'complete');
  assert.deepEqual(result.l3_updates, [receipt.summary]); assert.deepEqual(result.actions, [action.summary]); assert.deepEqual(result.l2_updates, [l2.summary]);
  assert.equal(result.receipt_refs.length, 3);
  assert.deepEqual((await settledSeal(out, ctx, {...native, output: ''})).l3_updates, [receipt.summary]);
});
test('run receipt read failure preserves obtained range and recovery reconciles without changing native reply or rerunning tools', async t => {
  const {storage, ctx} = await fixture(t); let unavailable = true; let reads = 0;
  const receipt = committedProjection();
  const out = new OutputAuthority(storage, {resolveReceipt: async () => receipt, listRunReceipts: async () => {
    reads++; if (unavailable) throw new Error('database offline'); return readSources([receipt]);
  }});
  await out.open(ctx, {reply_mode: 'text', receipt_refs: [receipt.receipt_ref]});
  const uncertain = await settledSeal(out, ctx, native);
  assert.equal(uncertain.receipt_status, 'partial'); assert.equal(uncertain.receipt_error, 'RUN_RECEIPTS_UNAVAILABLE');
  assert.deepEqual(uncertain.l3_updates, [receipt.summary]); assert.equal(uncertain.result_status, 'failed');
  assert.equal(uncertain.run_status, 'completed'); assert.equal(uncertain.reply_status, 'complete'); assert.equal(uncertain.delivery_status, 'unknown');
  unavailable = false;
  const reconciled = await settledSeal(out, ctx, native);
  assert.equal(reconciled.receipt_status, 'complete'); assert.equal(reconciled.receipt_error, null);
  assert.equal(reconciled.result_status, 'completed'); assert.equal(reconciled.reply_text, native.output);
  assert.ok(reconciled.result_revision > uncertain.result_revision); assert.equal(reads, 2);
  const unknown = new OutputAuthority(storage, {listRunReceipts: async () => {throw new Error('offline');}});
  const next = {...ctx, run_id: 'no-receipts'};
  await unknown.open(next, {reply_mode: 'none'});
  const result = await unknown.seal(next, {...native, run_id: next.run_id, output: ''});
  assert.equal(result.receipt_status, 'unknown'); assert.equal(result.result_status, 'failed'); assert.deepEqual(result.l3_updates, []);
});
test('model JSON claims never become receipts and conflicting actual source refs cannot masquerade as complete', async t => {
  const {storage, ctx} = await fixture(t);
  const out = new OutputAuthority(storage, {listRunReceipts: async () => readSources([])});
  await out.open(ctx, {reply_mode: 'text'});
  const result = await settledSeal(out, ctx, {...native, output: '{"l3_updates":[{"status":"committed","receipt_ref":"fake"}]}'});
  assert.deepEqual(result.l3_updates, []); assert.equal(result.receipt_status, 'complete');
  const receipt = committedProjection();
  const bad = new OutputAuthority(storage, {listRunReceipts: async () => ({sources:[{source:'l3',status:'complete',error:null,receipts:[receipt,{...receipt,status:'failed'}]}]})});
  const next = {...ctx, run_id: 'conflict'};
  await bad.open(next, {reply_mode: 'none'});
  const conflict = await bad.seal(next, {...native, run_id: next.run_id, output: ''});
  assert.equal(conflict.receipt_error, 'RUN_RECEIPTS_CONFLICT'); assert.equal(conflict.receipt_status, 'unknown'); assert.equal(conflict.result_status, 'failed');
});

test('independent source validation preserves valid facts and explicit configuration states', async t => {
  const {storage,ctx}=await fixture(t); const receipt=committedProjection();
  const action={receipt_ref:'action:separate',status:'committed',kind:'action' as const,summary:{status:'committed'}};
  const mixed=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[
    {source:'l3',status:'complete',error:null,receipts:[receipt,{...receipt,status:'failed'}]},
    {source:'action',status:'complete',error:null,receipts:[action]}]})});
  const partial=await mixed.seal(ctx,native);
  assert.equal(partial.receipt_status,'partial'); assert.equal(partial.receipt_error,'RUN_RECEIPTS_CONFLICT');
  assert.deepEqual(partial.actions,[action.summary]); assert.deepEqual(partial.l3_updates,[]);
  assert.deepEqual(partial.receipt_sources.map(source=>source.status),['failed','complete']);
  const emptyCtx={...ctx,run_id:'readable-empty'};
  const empty=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[
    {source:'l3',status:'failed',error:'RUN_RECEIPTS_UNAVAILABLE',receipts:[]},
    {source:'action',status:'complete',error:null,receipts:[]}]})});
  assert.equal((await empty.seal(emptyCtx,{...native,run_id:emptyCtx.run_id})).receipt_status,'partial');
  const configuredCtx={...ctx,run_id:'one-configured'};
  const configured=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[
    {source:'l3',status:'not_configured',error:null,receipts:[]},
    {source:'action',status:'complete',error:null,receipts:[]}]})});
  const complete=await configured.seal(configuredCtx,{...native,run_id:configuredCtx.run_id});
  assert.equal(complete.receipt_status,'complete'); assert.equal(complete.receipt_error,null);
  const disabledCtx={...ctx,run_id:'all-disabled'};
  const disabled=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[
    {source:'l3',status:'not_configured',error:null,receipts:[]},
    {source:'action',status:'not_configured',error:null,receipts:[]}]})});
  await disabled.open(disabledCtx,{reply_mode:'text'});
  const result=await disabled.seal(disabledCtx,{...native,run_id:disabledCtx.run_id});
  assert.equal(result.receipt_status,'unknown'); assert.equal(result.receipt_error,'RUN_RECEIPTS_SOURCE_NOT_CONFIGURED');
  assert.equal(result.result_status,'completed'); assert.equal(result.reply_status,'complete');
});

test('inspection leaves timeline untouched and both delivery entries project before returning',async t=>{
  const {storage,ctx,out}=await fixture(t),projected:unknown[]=[];
  out.setTimeline((_context,result)=>projected.push(result));
  await out.open(ctx,{reply_mode:'text'});await out.seal(ctx,native);projected.length=0;
  storage.publish=async()=>assert.fail('reads must not publish journal entries');
  const inspected=await out.inspectFinalized(ctx);
  assert.equal(inspected.result.reply_text,native.output);assert.deepEqual(projected,[]);
  for(const read of [()=>out.readSealedText(ctx),()=>out.readFinalized(ctx)]){
    const delivered=await read();
    assert.equal(projected.length,1);assert.strictEqual(projected.pop(),delivered.result);
    assert.deepEqual(delivered.result,inspected.result);
  }
  await out.inspectFinalized(ctx);assert.deepEqual(projected,[]);
});
test('readonly sealed projection preserves none and rejects unsealed/cancelled epochs',async t=>{
  const {storage,ctx}=await fixture(t),out=new OutputAuthority(storage,{listRunReceipts:async()=>({sources:[]})});
  await assert.rejects(out.readSealedText(ctx),/SEALED_TEXT_NOT_AVAILABLE/);
  const opened=await out.open(ctx,{reply_mode:'none'});await settledSeal(out, ctx,{...native,output:''});
  const replay=await out.readSealedText(ctx);assert.equal(replay.result.reply_mode,'none');assert.equal(replay.text_chunk_count,0);
  assert.equal(replay.pending_text_chunk_count,0);assert.equal(replay.rendered_text_through_seq,0);assert.deepEqual(replay.chunks,[]);
  await out.cancel(ctx,opened.reply_epoch!);await assert.rejects(out.readSealedText(ctx),/SEALED_TEXT_OLD_EPOCH/);
});

// The current D owns continuity, including MEDIA's legitimate l5-shaped references.
// Synthetic validated media D exercises the real OUT owner; no model or media service runs.
function mediaContinuation(ctx: OutputContext, continuityRef: string): void {
  ctx.d = {...ctx.d, media_type: 'audio', origin: 'device_observation', user_identity: 'unknown',
    segment_id: 'segment-fixture', segment_basis: 'speech_candidate', continuation_hint: 'open',
    processing: {...ctx.d.processing, path_id: 'fixture-media'},
    continuation: {continuity_ref: continuityRef, previous_processed_event_ids: [], relation: 'new',
      semantic_status: 'open', basis_refs: [ctx.d.raw_ref], policy_version: 'fixture-continuity-v1'}};
}
test('ordinary current D without continuity can deliver text when OPEN omits the optional reference', async t => {
  const {out, ctx} = await fixture(t);
  assert.equal(ctx.d.continuation, null);
  assert.equal((await out.open(ctx, {reply_mode: 'text'})).status, 'opened');
  assert.equal((await out.chunks(ctx, native)).map(chunk => chunk.text).join(''), native.output);
});
for (const form of ['semantic form', 'MEDIA l5 form'])
test(`exact current D continuation opens and delivers text (${form})`, async t => {
  const {out, ctx} = await fixture(t);
  const continuityRef = form === 'MEDIA l5 form' ? ctx.d.raw_ref : 'semantic-current';
  mediaContinuation(ctx, continuityRef);
  const opened = await out.open(ctx, {reply_mode: 'text', continuity_ref: ctx.d.continuation!.continuity_ref!});
  assert.equal(opened.status, 'opened'); assert.equal(opened.error_code, null);
  assert.equal((await out.chunks(ctx, native)).map(chunk => chunk.text).join(''), native.output);
});
for (const kind of ['mismatched', 'raw', 'processed', 'session', 'previous-D'] as const)
test(`non-exact ${kind} continuity reference cannot authorize text delivery`, async t => {
  const {out, ctx} = await fixture(t);
  mediaContinuation(ctx, 'semantic-current');
  const refs = {mismatched: 'semantic-other', raw: ctx.d.raw_ref, processed: ctx.d.processed_event_id,
    session: ctx.session_id, 'previous-D': `l5:${'a'.repeat(64)}`};
  const opened = await out.open(ctx, {reply_mode: 'text', continuity_ref: refs[kind]});
  assert.equal(opened.status, 'rejected'); assert.equal(opened.error_code, 'OUTPUT_CONTINUITY_DENIED');
  assert.equal(opened.reply_id, null); assert.deepEqual(await out.chunks(ctx, native), []);
  const result = await settledSeal(out, ctx, native);
  assert.equal(result.result_status, 'failed'); assert.equal(result.reply_text, '');
});
test('same legitimate prior MEDIA reference is denied when current ordinary D has no continuation', async t => {
  const {out, ctx} = await fixture(t);
  assert.equal(ctx.d.continuation, null);
  const opened = await out.open(ctx, {reply_mode: 'text', continuity_ref: `l5:${'a'.repeat(64)}`});
  assert.equal(opened.error_code, 'OUTPUT_CONTINUITY_DENIED'); assert.equal(opened.reply_id, null);
  assert.deepEqual(await out.chunks(ctx, native), []);
  assert.equal((await settledSeal(out, ctx, native)).reply_text, '');
});

for (const modes of [['voice'], ['text','voice']]) test(`voice-only source reply survives synth failure without subtitle expansion: ${modes.join('+')}`, async t => {
  const {storage, ctx} = await fixture(t); let calls = 0;
  const trusted = {...ctx, target: {...ctx.target, output_modes: modes}};
  const out = new OutputAuthority(storage, {tts: {synthesize: async text => {calls++; assert.equal(text, native.output); if (calls === 1) throw new Error('provider down'); return wavFixture();}}});
  await out.open(trusted, {reply_mode:'voice'});
  const failed = await settledSeal(out, trusted,native);
  assert.equal(failed.reply_text,native.output); assert.equal(failed.reply_status,'complete'); assert.equal(failed.reply_phase,'sealed');
  assert.equal(failed.result_status,'completed'); assert.equal(failed.voice_status,'failed'); assert.equal(failed.voice_error,'TTS_SYNTHESIS_FAILED');
  assert.equal(failed.delivery_status,'unknown'); assert.deepEqual(failed.output_plan,[{target_device_id:trusted.target.device_id,device_type:trusted.target.device_type,route_version:trusted.target.route_version,output_modes:['voice']}]);
  assert.deepEqual(await out.chunks(trusted,native),[]); assert.deepEqual(await settledVoiceChunks(out, trusted,native),[]);
  const restarted = new OutputAuthority(storage,{tts:{synthesize:async()=>{throw new Error('unexpected synthesis');}}});
  assert.equal((await restarted.readFinalized(trusted)).result.reply_status,'complete');
  await settledSeal(restarted, trusted,native); assert.equal(calls,1);
  const ready = await out.retryVoice(trusted,native); assert.equal(ready.voice_status,'ready'); assert.equal(ready.delivery_status,'unknown');
  const voice=(await settledVoiceChunks(out, trusted,native))[0]!;
  await assert.rejects(out.ack(trusted,ack(voice,1,'rendered')),/CHANNEL_MISMATCH/);
  await out.ack(trusted,ack(voice,1,'accepted')); assert.equal((await settledSeal(out, trusted,native)).delivery_status,'accepted');
  await out.ack(trusted,ack(voice,1,'played')); assert.equal((await settledSeal(out, trusted,native)).delivery_status,'played');
  await out.cancel(trusted,voice.reply_epoch); const cancelled=await out.readFinalized(trusted);
  assert.equal(cancelled.result.reply_status,'partial'); assert.equal(cancelled.result.reply_phase,'interrupted');
  assert.deepEqual(cancelled.voice_chunks,[]); await assert.rejects(out.ack(trusted,ack(voice,1,'played')),/OLD_EPOCH/);
});
test('voice synthesis failure does not conceal independent receipt business failure',async t=>{
  const {storage,ctx}=await fixture(t); const trusted={...ctx,target:{...ctx.target,output_modes:['voice']}};
  const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{throw new Error('tts unavailable');}},
    listRunReceipts:async()=>({sources:[{source:'action',status:'failed',error:'ACTION_READ_FAILED',receipts:[]}]})});
  await out.open(trusted,{reply_mode:'voice'});const result=await settledSeal(out, trusted,native);
  assert.equal(result.reply_status,'complete');assert.equal(result.reply_text,native.output);assert.equal(result.reply_phase,'sealed');
  assert.equal(result.result_status,'failed');assert.equal(result.receipt_status,'unknown');assert.equal(result.receipt_error,'ACTION_READ_FAILED');assert.equal(result.voice_status,'failed');
  assert.equal(result.delivery_status,'unknown');assert.ok(result.receipt_error);assert.deepEqual(result.actions,[]);
});

test('errand outreach persists one stream recipient without changing sealed binding or regenerating audio',async t=>{
  const {storage,ctx}=await fixture(t,true);
  const context={...ctx,target:{...ctx.target,output_modes:['text','voice']}};
  let calls=0;
  const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{throw Error('must stream');},stream:async function*(){calls++;yield wavFixture();yield wavFixture();}}});
  await out.open(context,{reply_mode:'text_and_voice'});
  await settledSeal(out,context,native);
  const original=await out.readFinalized(context);
  const target={device_id:'phone-two',device_type:'phone' as const,route_version:'phone-route',output_modes:['text','voice']};
  await out.selectErrandRecipient(context,target);
  const restarted=new OutputAuthority(storage);
  assert.deepEqual(await restarted.deliveryTarget(context),target);
  const selected=await restarted.readFinalized(context);
  assert.equal(selected.chunks[0]!.target_device_id,target.device_id);
  assert.deepEqual(selected.voice_chunks.map(chunk=>[chunk.seq,chunk.target_device_id]),[[1,target.device_id],[2,target.device_id]]);
  assert.equal((selected.result.output_plan[0] as {route_version:string}).route_version,target.route_version);
  assert.deepEqual(selected.voice_chunks.map(chunk=>chunk.audio.ref),original.voice_chunks.map(chunk=>chunk.audio.ref));
  assert.equal(calls,1);
  await assert.rejects(restarted.ack(context,ack(original.chunks[0]!,original.chunks.length)),/BINDING_MISMATCH/);
  const textReceipt=await restarted.ack(context,ack(selected.chunks[0]!,selected.chunks.length));
  const voiceReceipt=await restarted.ack(context,ack(selected.voice_chunks[0]!,2,'played'));
  assert.equal(textReceipt.target_device_id,target.device_id);assert.equal(voiceReceipt.route_version,target.route_version);
  assert.equal((await restarted.readFinalized(context)).result.delivery_status,'played');
  assert.ok((await restarted.getAudio(context,selected.voice_chunks[0]!.audio.ref)).bytes.length);
  assert.deepEqual(await restarted.selectErrandRecipient(context,target),target);
  assert.deepEqual(await restarted.selectErrandRecipient(context,{...target,device_id:'phone-three'}),target,'a later active terminal cannot split the stream');
  await assert.rejects(restarted.readFinalized({...context,target}),/CONTEXT_CONFLICT/);
});
test('ordinary replies and already delivered errands cannot acquire an outreach recipient',async t=>{
  const ordinary=await fixture(t),errand=await fixture(t,true);
  for(const item of [ordinary,errand]){await item.out.open(item.ctx,{reply_mode:'text'});await item.out.seal(item.ctx,native);}
  await assert.rejects(ordinary.out.selectErrandRecipient(ordinary.ctx,ordinary.ctx.target),/ERRAND_REQUIRED/);
  const chunks=await errand.out.chunks(errand.ctx,native);
  await errand.out.ack(errand.ctx,ack(chunks[0]!,chunks.length));
  await assert.rejects(errand.out.selectErrandRecipient(errand.ctx,errand.ctx.target),/DELIVERY_ALREADY_STARTED/);
});
test('an errand native failure remains a failed result when outreach changes terminals',async t=>{
  const {out,ctx}=await fixture(t,true);await out.open(ctx,{reply_mode:'text'});
  await out.seal(ctx,{run_id:native.run_id,session_id:native.session_id,conversation_session_id:native.conversation_session_id,status:'failed'});
  await out.selectErrandRecipient(ctx,{...ctx.target,device_id:'active-phone',device_type:'phone'});
  const value=await out.readFinalized(ctx);assert.equal(value.result.reply_status,'failed');assert.deepEqual(value.chunks,[]);
});


test('notification delivery preserves old voice journal bindings while fresh opens select text without TTS',async t=>{
  const {storage,ctx}=await fixture(t);ctx.target.output_modes=['text','voice'];const capturedTarget=structuredClone(ctx.target);
  let calls=0;const out=new OutputAuthority(storage,{tts:{synthesize:async()=>{calls++;return wavFixture();}}});t.after(()=>out.close());
  assert.equal((await out.open(ctx,{reply_mode:'voice'})).reply_mode,'voice');
  await settledSeal(out,ctx,native);assert.equal(calls,1);
  const notified:OutputContext={...ctx,delivery:'text_notification'};
  const legacy=await out.readSealedText(notified);
  assert.equal(legacy.result.reply_mode,'voice');assert.equal(legacy.result.reply_text,native.output);
  assert.equal(legacy.result.voice_status,'ready');
  await out.recordCallResultDelivery(notified,'voice');
  assert.equal(await new OutputAuthority(storage).callResultDelivered(notified),true,'live delivery remains deduplicated after OUT restart');
  const fresh={...notified,run_id:'run-new-notification'};
  assert.equal((await out.open(fresh,{reply_mode:'voice'})).reply_mode,'text');
  const result=await settledSeal(out,fresh,{...native,run_id:fresh.run_id});
  assert.equal(result.reply_mode,'text');assert.equal(result.voice_status,'none');assert.equal(calls,1);
  await out.recordCallResultDelivery(fresh,'text');
  assert.equal(await new OutputAuthority(storage).callResultDelivered(fresh),true,'accepted text deduplicates after OUT restart without a render ACK');
  assert.equal((await out.readSealedText(fresh)).result.delivery_status,'unknown');
  assert.deepEqual(ctx.target,capturedTarget);assert.deepEqual(fresh.target,capturedTarget);
});

test('small provider frames and played ACKs settle within the output journal budget', {timeout:180000}, async t => {
  const {storage,ctx}=await fixture(t);ctx.target.output_modes=['voice'];
  const journal=new Map<string,Uint8Array>(),read=storage.read.bind(storage),publish=storage.publish.bind(storage);
  storage.read=async(kind,key)=>{if(kind!=='output-journal')return read(kind,key);const value=journal.get(key);if(value)return value;throw Object.assign(Error('missing'),{code:'ENOENT'});};
  storage.publish=async(kind,key,bytes)=>{if(kind!=='output-journal')return publish(kind,key,bytes);if(!journal.has(key))journal.set(key,bytes);return journal.get(key)!;};
  let calls=0,played=0,pcmBytes=0;
  const out=new OutputAuthority(storage,{tts:{synthesize:async()=>wavFixture(),stream:async function*(){calls++;for(let n=0;n<530;n++)yield wavFixture();}}});
  const done=Promise.withResolvers<void>();
  out.setVoiceOwner(async(context,error)=>{
    if(error){done.reject(error);return;}
    const snapshot=await out.readFinalized(context);
    const legacy=[...journal.values()].map(bytes=>JSON.parse(Buffer.from(bytes).toString())).filter(entry=>entry.voice).at(-1).voice;
    if(snapshot.result.voice_status==='pending')assert.equal(legacy.chunk.seq,1);
    for(const chunk of snapshot.voice_chunks)if(chunk.seq>played){pcmBytes+=(await out.getAudio(context,chunk.audio.ref)).bytes.length-44;await out.ack(context,ack(chunk,chunk.seq,'played'));played=chunk.seq;}
    if(snapshot.result.voice_status!=='pending')done.resolve();
  });
  void done.promise.catch(()=>undefined);
  await out.open(ctx,{reply_mode:'voice'});await out.seal(ctx,native);await done.promise;await out.close();
  const restarted=new OutputAuthority(storage),final=await restarted.readFinalized(ctx);
  assert.equal(final.result.voice_status,'ready');assert.equal(final.result.delivery_status,'played');
  assert.deepEqual(final.voice_chunks,[]);assert.equal(calls,1);assert.ok(played>0);assert.ok(journal.size<1024);assert.equal(pcmBytes,530*200);
  const legacy=[...journal.values()].map(bytes=>JSON.parse(Buffer.from(bytes).toString())).filter(entry=>entry.voice).at(-1).voice;
  assert.equal(legacy.status,'ready');assert.equal(legacy.chunks.length,played);assert.equal(legacy.chunks.at(-1).final,true);
});

for (const failedKind of ['derived-audio','output-journal']) test(`voice publication failure (${failedKind}) settles durably and restart refuses partial paid synthesis replay`,async t=>{
  const {storage,ctx}=await fixture(t);ctx.target.output_modes=['voice'];
  const publish=storage.publish.bind(storage);let audioWrites=0,calls=0;
  storage.publish=async(kind,key,bytes)=>{if(kind===failedKind&&(kind==='derived-audio'||JSON.parse(Buffer.from(bytes).toString()).operation?.startsWith('voice-chunk:'))&&++audioWrites===2)throw Error('synthetic disk failure');return publish(kind,key,bytes);};
  const tts={synthesize:async()=>wavFixture(),stream:async function*(){calls++;yield wavFixture();yield wavFixture();}};
  const out=new OutputAuthority(storage,{tts});await out.open(ctx,{reply_mode:'voice'});
  await assert.rejects(settledSeal(out,ctx,native),/synthetic disk failure/);
  assert.equal((await out.readFinalized(ctx)).result.voice_status,'failed');
  const legacy=(await Reflect.get(out,'state').call(out,ctx)).entries.filter((entry:{voice?:unknown})=>entry.voice).at(-1).voice;
  assert.equal(legacy.status,'failed');assert.equal(legacy.chunks.length,1);
  await out.close();const restarted=new OutputAuthority(storage,{tts});
  assert.equal((await restarted.readFinalized(ctx)).result.voice_status,'failed');
  await assert.rejects(restarted.retryVoice(ctx,native),/OUTPUT_VOICE_PARTIAL_RETRY_UNSAFE/);
  assert.equal(calls,1);assert.equal((await restarted.readFinalized(ctx)).voice_chunks.length,1);
});

test('voice settlement and cancellation retain slots when ACKs reach journal capacity',async t=>{
  const {storage,ctx}=await fixture(t);ctx.target.output_modes=['voice'];
  const release=Promise.withResolvers<void>(),published=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
  const tts={synthesize:async()=>wavFixture(),stream:async function*(){yield wavFixture();await release.promise;}};
  const out=new OutputAuthority(storage,{tts,maxJournalEntries:9});
  out.setVoiceOwner(async(context,error)=>{if(error){done.reject(error);return;}const state=await out.readFinalized(context);
    if(state.result.voice_status==='pending')published.resolve();else done.resolve();});
  await out.open(ctx,{reply_mode:'voice'});await out.seal(ctx,native);await published.promise;
  const chunk=(await out.readFinalized(ctx)).voice_chunks[0]!;
  await out.ack(ctx,ack(chunk,1,'played'));
  await assert.rejects(out.ack(ctx,{...ack(chunk,1,'played'),observed_at:'2026-10-01T00:00:01.000Z'}),/OUTPUT_JOURNAL_FULL/);
  release.resolve();await done.promise;await out.close();
  assert.equal((await out.readFinalized(ctx)).result.voice_status,'ready');
  await out.cancel(ctx,1);
  const restarted=new OutputAuthority(storage,{tts,maxJournalEntries:9});
  assert.equal((await restarted.readFinalized(ctx)).result.reply_phase,'interrupted');
  assert.deepEqual((await restarted.readFinalized(ctx)).voice_chunks,[]);
});
