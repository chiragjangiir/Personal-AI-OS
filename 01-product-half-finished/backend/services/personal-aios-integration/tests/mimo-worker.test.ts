import {materialized} from './stream-materialized-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamArchive} from '../src/stream-archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {alignSegment} from '../src/media/align.ts';
import {MediaProcessor, type WorkerRequest} from '../src/media/processing.ts';
import {MimoWorker, mimoCapability, MIMO_BASE, type MimoConfig} from '../src/media/mimo-worker.ts';
import type {RawEvent, TimeRange, TrustedContext} from '../src/contracts.ts';

const config: MimoConfig = {model: 'alternate-joint-media',timeout_ms: 500,
  max_input_bytes: 100000, max_output_bytes: 65536, max_completion_tokens: 1024,
  max_views: 16, max_duration_ms: 1000};
const pcm = Buffer.alloc(320, 7);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const at = '2026-10-02T00:00:00.000Z';
const trusted: TrustedContext = {principal_id: 'owner', device_id: 'glasses', device_type: 'glasses',
  consent_ref: 'fixture', channel: 'fixture', submission: 'observation'};
const window: TimeRange = {kind: 'interval', timebase_id: 'common', start_ms: 1000, end_ms: 1040};
const response = (finish = 'stop', extra = {}, content = JSON.stringify({transcript: '选红杯',
  description: 'Audio asks for red cup; supplied frame shows red cup.', uncertainty: 'Sparse frames; synchronization unverified.'})) =>
  new Response(JSON.stringify({model: config.model, usage: {prompt_tokens: 42}, choices: [{finish_reason: finish,
    message: {role: 'assistant', content, reasoning_content: 'secret reasoning', tool_calls: null, ...extra}}]}));

async function fixture(t: test.TestContext, fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'paios-mimo-controlled-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const storage = new PosixStorage(directory);
  const archive = new StreamArchive(storage, {max_chunk_bytes: 10000, max_total_bytes: 100000,
    max_chunks: 16, max_revisions: 16, max_seq: 16});
  const raw = (payload: Uint8Array): RawEvent => ({schema_version: 'paios.event.v1', event_id: 'stream',
    device_id: 'glasses', device_type: 'glasses', captured_at: at, source: {channel: 'fixture'},
    media_type: 'livekit_tracks', mime: 'application/octet-stream', representation: 'received_decoded_sample', payload});
  for (const [seq, start_ms] of [[0, 0], [1, 10], [2, 30]] as const) {
    await archive.append(raw(pcm), trusted, at, {track_id: 'mic', stream_epoch: 'e1', seq,
      modality: 'audio', format: 'pcm_s16le:16000:1', source_range: {kind: 'interval',
        timebase_id: 'samples', stream_epoch: 'e1', start_ms, end_ms: start_ms + 10}});
  }
  const b = await archive.append(raw(png), trusted, at, {track_id: 'cam', stream_epoch: 'e1', seq: 0,
    modality: 'visual', format: 'png', source_range: {kind: 'instant', timebase_id: 'samples', stream_epoch: 'e1', at_ms: 5}});
  const maps = (['audio', 'visual'] as const).map(modality => ({modality, track_id: modality === 'audio' ? 'mic' : 'cam',
    stream_epoch: 'e1', source_timebase_id: 'samples', target_timebase_id: 'common', offset_ms: 1000,
    drift_ppm: 0, uncertainty_ms: 0, basis_ref: 'fixture-clock'}));
  const aligned = await alignSegment(b.event, (await materialized(storage,b)), window, 'speech_candidate', maps, storage,
    {max_chunks: 16, max_visual_refs: 4, max_frame_gap_ms: 100, max_uncertainty_ms: 1});
  const worker = new MimoWorker(config, () => 'controlled-test-only', fetcher);
  const processor = new MediaProcessor(storage, new Map([['mimo-cloud', worker]]), {policy_version: 'mimo.controlled',
    max_inflight: 1, max_input_bytes: 100000, timeout_ms: 1000, allow_external: true, allow_replay: true, allow_partial: true});
  t.after(() => processor.close());
  return {storage, aligned, processor, worker, request: await processor.prepareRequest(aligned.segment, aligned.views)};
}

test('real source selection packs only contiguous PCM and PNG into one request, consumer owns partial D and scope', async t => {
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++;
    assert.equal(url, `${MIMO_BASE}/chat/completions`);
    const body = JSON.parse(init!.body as string);
    assert.equal(body.tools, undefined);assert.equal(body.thinking.type,'disabled');
    assert.equal(body.model,config.model);assert.deepEqual(body.response_format, {type: 'json_object'});
    const parts = body.messages[1].content;
    const audios = parts.filter((p: {type: string}) => p.type === 'input_audio');
    assert.equal(audios.length, 2);
    const buffers = audios.map((p: {input_audio: {data: string}}) => Buffer.from(p.input_audio.data.split(',')[1]!, 'base64'));
    assert.equal(buffers[0].toString('ascii', 0, 4), 'RIFF');
    assert.equal(buffers[0].readUInt32LE(24), 16000);
    assert.deepEqual(buffers[0].subarray(44), Buffer.concat([pcm, pcm]));
    assert.deepEqual(buffers[1].subarray(44), pcm);
    assert.equal(parts.filter((p: {type: string}) => p.type === 'image_url').length, 1);
    assert.ok(JSON.stringify(parts).includes('1030'));
    return response();
  }) as typeof fetch;
  const f = await fixture(t, fetcher);
  const d = await f.processor.process(f.aligned.segment, f.aligned.views,
    [{...mimoCapability(config), healthy: true, permitted: true, evidence: 'deterministic_replay'}]);
  assert.equal(calls, 1);
  assert.equal(d.quality.status, 'partial');
  assert.equal(d.event_id, f.request.event_id);
  assert.equal(d.archive_revision, f.request.archive_revision);
  assert.deepEqual(d.time_range, window);
  assert.equal(d.raw_ref, f.aligned.segment.raw_ref);
  assert.equal(d.content.transcript, '选红杯');
  assert.ok(d.content.audio_observations && d.content.visual_observations);
  assert.ok(!JSON.stringify(d).includes('secret reasoning'));
  assert.deepEqual(d.speakers, []);
  assert.deepEqual(await f.processor.process(f.aligned.segment, f.aligned.views, []), d);
  assert.equal(calls, 1);
});

test('single modalities preserve scope without fabricated track, null/absent tools are normal', async t => {
  const f = await fixture(t, (async () => response()) as typeof fetch);
  const audio = await f.worker.analyze({...f.request, views: f.request.views.filter(v => v.modality === 'audio')}, new AbortController().signal);
  assert.equal(audio.content.visual_observations, undefined);
  const visualWorker = new MimoWorker(config, () => 'test', (async () => response('stop', {tool_calls: undefined},
    JSON.stringify({transcript: null, description: 'Red cup.', uncertainty: 'One frame.'}))) as typeof fetch);
  const visual = await visualWorker.analyze({...f.request, views: f.request.views.filter(v => v.modality === 'visual')}, new AbortController().signal);
  assert.equal(visual.content.transcript, undefined);
  assert.equal(visual.content.audio_observations, undefined);
});

test('illegal source never reads credentials or dispatches; response cannot self-author scope', async t => {
  const f = await fixture(t, (async () => response()) as typeof fetch);
  let keys = 0, calls = 0;
  const worker = new MimoWorker(config, () => {keys++; return 'test';}, (async () => {calls++; return response();}) as typeof fetch);
  await assert.rejects(worker.analyze({...f.request, input_contract: 'paios.media.full-chunks.v1'}, new AbortController().signal), /INPUT_CONTRACT/);
  const views = structuredClone(f.request.views);
  const bytes = views.find(v => v.modality === 'audio')!.bytes;
  bytes[0] = bytes[0]! ^ 1;
  await assert.rejects(worker.analyze({...f.request, views}, new AbortController().signal), /HASH|SELECTION/);
  await assert.rejects(worker.analyze({...f.request, time_range: {...window, start_ms: 2000, end_ms: 2040} as TimeRange}, new AbortController().signal));
  assert.equal(keys, 0); assert.equal(calls, 0);
  const forged = new MimoWorker(config, () => 'test', (async () => response('stop', {}, JSON.stringify({transcript: null,
    description: 'cup', uncertainty: 'unknown', event_id: 'forged'}))) as typeof fetch);
  await assert.rejects(forged.analyze(f.request, new AbortController().signal), /CONTENT_SCHEMA/);
  assert.equal(mimoCapability(config).healthy, false);
  assert.equal(mimoCapability(config).evidence, 'unverified');
});

test('refusal/tool proposals and broken JSON fail; valid length is partial, incomplete length is failure', async t => {
  const f = await fixture(t, (async () => response()) as typeof fetch);
  for (const extra of [{tool_calls: [{id: 'must-not-run'}]}, {refusal: 'denied'}]) {
    await assert.rejects(new MimoWorker(config, () => 'test', (async () => response('stop', extra)) as typeof fetch)
      .analyze(f.request, new AbortController().signal), /FINAL_CONTENT_REQUIRED/);
  }
  const truncated = await new MimoWorker(config, () => 'test', (async () => response('length')) as typeof fetch)
    .analyze(f.request, new AbortController().signal);
  assert.equal(truncated.status, 'partial');
  assert.ok(truncated.warnings.includes('MIMO_GENERATION_TRUNCATED'));
  await assert.rejects(new MimoWorker(config, () => 'test', (async () => response('length', {}, '{')) as typeof fetch)
    .analyze(f.request, new AbortController().signal), /CONTENT_JSON_INVALID/);
  await assert.rejects(new MimoWorker(config, () => 'test', (async () => new Response('', {status: 429})) as typeof fetch)
    .analyze(f.request, new AbortController().signal), /HTTP_FAILED/);
});

test('pre-dispatch cancellation reads no key; active HTTP deadline aborts and retains consumer slot lifecycle', async t => {
  const f = await fixture(t, (async () => response()) as typeof fetch);
  let keys = 0;
  const worker = new MimoWorker({...config, timeout_ms: 20}, () => {keys++; return 'test';},
    (async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once: true});
    })) as typeof fetch);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(worker.analyze(f.request, abort.signal), /MEDIA_CANCELLED/);
  assert.equal(keys, 0);
  const hold = setTimeout(() => {}, 100);
  try {await assert.rejects(worker.analyze(f.request, new AbortController().signal), /timeout/i);}
  finally {clearTimeout(hold);}
});
