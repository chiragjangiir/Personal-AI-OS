import {materialized} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical, digest, sha256, type RawEvent, type TimeRange, type TrustedContext} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {RawArchive} from '../src/archive.ts';
import {alignSegment, type ClockMap} from '../src/media/align.ts';
import {FeatureReplayWorker, MediaProcessor, type Capability, type WorkerPort, type WorkerRequest} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';

const at = '2026-10-02T00:00:00.000Z';
const trusted: TrustedContext = {
  principal_id: 'owner', device_id: 'glasses', device_type: 'glasses',
  consent_ref: 'fixture', channel: 'fixture', submission: 'observation'
};
const budget = {max_chunk_bytes: 10000, max_total_bytes: 100000, max_chunks: 30, max_revisions: 30, max_seq: 30};
const config = {
  policy_version: 'scoped-pcm.fixture.v1', max_inflight: 4, max_input_bytes: 100000,
  timeout_ms: 500, allow_external: false, allow_replay: true, allow_partial: true
};
const alignment = {max_chunks: 30, max_visual_refs: 10, max_frame_gap_ms: 100, max_uncertainty_ms: 5};
const cap: Capability = {
  id: 'feature', version: '1', modalities: ['audio', 'visual'], formats: ['pcm_s16le:1000:1', 'pcm_s16le:16000:1', 'png'],
  joint_av: true, healthy: true, permitted: true, max_duration_ms: 1000,
  execution: 'local', evidence: 'deterministic_replay'
};
const window = (start_ms: number, end_ms: number): TimeRange => ({kind: 'interval', timebase_id: 'common', start_ms, end_ms});
const map = (track_id = 'mic', stream_epoch = 'e1', offset_ms = 1000, drift_ppm = 100000): ClockMap => ({
  modality: 'audio', track_id, stream_epoch, source_timebase_id: 'samples', target_timebase_id: 'common',
  offset_ms, drift_ppm, uncertainty_ms: 2, basis_ref: 'clock:fixture-calibration'
});
const pcm = (samples = 100): Buffer => {
  const bytes = Buffer.alloc(samples * 2);
  for (let n = 0; n < samples; n++) bytes.writeInt16LE(n * 13 + 7, n * 2);
  return bytes;
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
const raw = (payload: Uint8Array, visual = false): RawEvent => ({
  schema_version: 'paios.event.v1', event_id: 'stream', device_id: 'glasses', device_type: 'glasses',
  captured_at: at, source: {channel: 'fixture'}, media_type: 'livekit_tracks',
  mime: visual ? 'image/png' : 'audio/pcm', representation: 'received_decoded_sample', payload
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'paios-scoped-pcm-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const storage = new PosixStorage(directory);
  const archive = new StreamArchive(storage, budget);
  const processor = new MediaProcessor(storage, new Map([['feature', new FeatureReplayWorker()]]), config);
  const append = (start_ms = 0, track_id = 'mic', stream_epoch = 'e1', seq = 0, samples = 100, sample_rate = 1000) =>
    archive.append(raw(pcm(samples)), trusted, at, {
      track_id, stream_epoch, seq, modality: 'audio', format: `pcm_s16le:${sample_rate}:1`,
      source_range: {kind: 'interval', timebase_id: 'samples', stream_epoch, start_ms, end_ms: start_ms + samples * 1000 / sample_rate}
    });
  return {directory, storage, archive, processor, append};
}

test('source selects actual PCM bytes with offset, positive drift, explicit fractional rounding and unchanged originals', async t => {
  const f = await fixture(t);
  const archived = await f.append();
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1010.25, 1050.25), 'speech_candidate', [map()], f.storage, alignment);
  const originalViews = canonical(aligned.views);
  const originalSegment = canonical(aligned.segment);
  const request = await f.processor.prepareRequest(aligned.segment, aligned.views);
  assert.equal(request.input_contract, 'paios.media.selected-pcm.v1');
  assert.deepEqual(request.time_range, window(1010.25, 1050.25));
  assert.deepEqual(request.coverage, aligned.segment.coverage);
  const view = request.views[0]!;
  assert.deepEqual(Buffer.from(view.bytes), pcm().subarray(20, 92));
  assert.deepEqual(view.time_range, window(1011, 1050.6));
  assert.equal(view.ref, aligned.views[0]!.ref);
  assert.deepEqual(view.pcm_selection!.source_range, aligned.views[0]!.chunk.source_range);
  assert.deepEqual(view.pcm_selection!.mapped_range, window(1000, 1110));
  assert.equal(view.pcm_selection!.first_sample, 10);
  assert.equal(view.pcm_selection!.end_sample_exclusive, 46);
  assert.equal(view.pcm_selection!.selected_sha256, sha256(view.bytes));
  assert.equal(view.pcm_selection!.selected_source_range.kind, 'interval');
  assert.deepEqual(view.pcm_selection!.selected_source_range, {kind: 'interval', timebase_id: 'samples', stream_epoch: 'e1', start_ms: 10, end_ms: 46});
  const replay = await new FeatureReplayWorker().analyze(request, new AbortController().signal);
  assert.match(replay.warnings.join('|'), /PCM_FEATURES:samples=36:/);
  assert.equal(canonical(aligned.views), originalViews);
  assert.equal(canonical(aligned.segment), originalSegment);
  assert.deepEqual(Buffer.from(await f.storage.read('objects', aligned.views[0]!.chunk.object_hash)), pcm());
  request.views[0]!.bytes.fill(0);
  assert.deepEqual(Buffer.from(await f.storage.read('objects', aligned.views[0]!.chunk.object_hash)), pcm());
});

test('joint and audio-only workers receive identical source selection; cached D calls no new worker or health', async t => {
  const f = await fixture(t);
  await f.append();
  const archived = await f.archive.append(raw(png, true), trusted, at, {
    track_id: 'cam', stream_epoch: 'e1', seq: 0, modality: 'visual', format: 'png',
    source_range: {kind: 'instant', timebase_id: 'samples', stream_epoch: 'e1', at_ms: 20}
  });
  const cameraMap = {...map('cam'), modality: 'visual' as const};
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1010.25, 1050.25), 'speech_candidate', [map(), cameraMap], f.storage, alignment);
  const captured: WorkerRequest[] = [];
  const worker: WorkerPort = {analyze: async (request, signal) => {
    captured.push(request);
    return new FeatureReplayWorker().analyze(request, signal);
  }};
  const processor = new MediaProcessor(f.storage, new Map([['feature', worker]]), config);
  const d = await processor.process(aligned.segment, aligned.views, [cap]);
  assert.equal(captured.length, 1);
  assert.ok(d.quality.warnings.some(w => w.startsWith('PCM_SAMPLE_BOUNDARY_QUANTIZED:')));
  const recordKey = digest([aligned.segment.raw_ref, aligned.segment.segment_id, 1]);
  const input = JSON.parse(new TextDecoder().decode(await f.storage.read('processed-media-inputs', recordKey)));
  assert.equal(input.input_contract, 'paios.media.selected-pcm.v1');
  assert.deepEqual(input.selected_views[0].pcm_selection, captured[0]!.views[0]!.pcm_selection);
  assert.equal(input.selected_input_sha256, digest({input_contract: input.input_contract, views: input.selected_views}));
  assert.deepEqual(Buffer.from(captured[0]!.views.find(v => v.modality === 'visual')!.bytes), png);
  assert.deepEqual(captured[0]!.views.find(v => v.modality === 'visual')!.time_range, aligned.views.find(v => v.chunk.modality === 'visual')!.mapped_range);
  const cached = await processor.process(aligned.segment, aligned.views, async () => {throw new Error('must not query health');});
  assert.deepEqual(cached, d);
  assert.equal(captured.length, 1);
  await processor.process(aligned.segment, aligned.views, [{...cap, modalities: ['audio']}], 2, d.processed_event_id);
  assert.equal(captured.length, 2);
  assert.equal(captured[1]!.views.length, 1);
  assert.deepEqual(captured[1]!.views[0]!.bytes, captured[0]!.views.find(v => v.modality === 'audio')!.bytes);
  assert.deepEqual(captured[1]!.coverage, aligned.segment.coverage);
});

test('adjacent chunks, gaps, track and epoch identities stay separate with original mapped coordinates', async t => {
  const f = await fixture(t);
  await f.append(0);
  await f.append(100, 'mic', 'e1', 1);
  await f.append(300, 'mic', 'e1', 3);
  await f.append(0, 'other', 'e1');
  const archived = await f.append(0, 'mic', 'e2');
  const maps = [map(), map('other'), map('mic', 'e2', 1100)];
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1055, 1385), 'speech_candidate', maps, f.storage, alignment);
  const request = await f.processor.prepareRequest(aligned.segment, aligned.views);
  assert.equal(request.views.length, 5);
  const mic = request.views.filter(v => v.pcm_selection!.track_id === 'mic' && v.pcm_selection!.stream_epoch === 'e1');
  assert.deepEqual(mic.map(v => v.pcm_selection!.seq), [0, 1, 3]);
  assert.deepEqual(mic.map(v => v.time_range), [window(1055, 1110), window(1110, 1220), window(1330, 1385)]);
  assert.ok(request.coverage.missing_ranges.length > 0);
  assert.deepEqual(request.coverage, aligned.segment.coverage);
  assert.equal(request.views.find(v => v.pcm_selection!.stream_epoch === 'e2')!.pcm_selection!.track_id, 'mic');
  assert.equal(request.views.find(v => v.pcm_selection!.track_id === 'other')!.pcm_selection!.stream_epoch, 'e1');
});

test('MediaService VAD receives source-selected bytes before its own candidate range and worker receives the new C crop', async t => {
  const f = await fixture(t);
  const archived = await f.append(0, 'mic', 'e1', 0, 1600, 16000);
  let vadRequest: WorkerRequest | undefined;
  let workerRequest: WorkerRequest | undefined;
  const worker: WorkerPort = {analyze: async (request, signal) => {
    workerRequest = request;
    return new FeatureReplayWorker().analyze(request, signal);
  }};
  const processor = new MediaProcessor(f.storage, new Map([['feature', worker]]), config);
  const service = new MediaService({
    storage: f.storage, archive: new RawArchive(f.storage, 10000, undefined, budget), streamArchive: f.archive, processor,
    capabilities: async () => [cap], fixtureOnly: true, align: alignment, max_segments: 4, max_window_ms: 1000,
    vad: {candidates: async request => {
      vadRequest = request;
      return [{start_ms: 1022, end_ms: 1033, semantic_status: 'open', basis: 'fixture'}];
    }}
  });
  const result = await service.process('owner', {
    raw_ref: archived.event.raw_ref, archive_revision: archived.event.archive_revision,
    time_range: window(1011, 1044), clock_maps: [map()]
  });
  assert.equal(result.status, 'processed');
  assert.equal(vadRequest!.input_contract, 'paios.media.selected-pcm.v1');
  assert.deepEqual(Buffer.from(vadRequest!.views[0]!.bytes), pcm(1600).subarray(320, 1280));
  assert.deepEqual(vadRequest!.views[0]!.time_range, window(1011, 1044));
  assert.deepEqual(Buffer.from(workerRequest!.views[0]!.bytes), pcm(1600).subarray(640, 960));
  assert.deepEqual(workerRequest!.time_range, window(1022, 1033));
});

test('sealed scope, object SHA and full source budget cannot be bypassed by a small selected window', async t => {
  const f = await fixture(t);
  const archived = await f.append();
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1010, 1012), 'speech_candidate', [map()], f.storage, alignment);
  const changed = structuredClone(aligned.views);
  changed[0]!.mapped_range = window(1000, 1200);
  await assert.rejects(f.processor.prepareRequest(aligned.segment, changed), /MEDIA_INPUT_SCOPE_MISMATCH/);
  const small = new MediaProcessor(f.storage, new Map(), {...config, max_input_bytes: 100});
  await assert.rejects(small.prepareRequest(aligned.segment, aligned.views), /MODEL_INPUT_BUDGET_EXCEEDED/);
  const objectPath = join(f.directory, 'objects', aligned.views[0]!.chunk.object_hash);
  const before = await readFile(objectPath);
  const tampered = Buffer.from(before);
  tampered[0] = tampered[0]! ^ 1;
  await writeFile(objectPath, tampered);
  await assert.rejects(f.processor.prepareRequest(aligned.segment, aligned.views), /MEDIA_OBJECT_INTEGRITY/);
});

test('sub-sample C with no sample starts fails explicitly instead of claiming exact coverage', async t => {
  const f = await fixture(t);
  const archived = await f.append();
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1010.1, 1010.2), 'speech_candidate', [map()], f.storage, alignment);
  await assert.rejects(f.processor.prepareRequest(aligned.segment, aligned.views), /MEDIA_PCM_WINDOW_NO_SAMPLES/);
});

test('pending historical input without contract is refused, while historical cached D remains replayable', async t => {
  const f = await fixture(t);
  const archived = await f.append();
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1011, 1055), 'speech_candidate', [map()], f.storage, alignment);
  const d = await f.processor.process(aligned.segment, aligned.views, [cap]);
  const key = digest([aligned.segment.raw_ref, aligned.segment.segment_id, 1]);
  const inputPath = join(f.directory, 'processed-media-inputs', key);
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  delete input.input_contract;
  await writeFile(inputPath, canonical(input));
  assert.deepEqual(await f.processor.process(aligned.segment, aligned.views, async () => {throw new Error('no health');}), d);
  await rm(join(f.directory, 'processed-media', key));
  await assert.rejects(f.processor.process(aligned.segment, aligned.views, [cap]), /MEDIA_INPUT_CONTRACT_REVISION_REQUIRED/);
});


test('selected replay refuses legacy or tampered selection instead of independently cropping', async t => {
  const f = await fixture(t);
  const archived = await f.append();
  const aligned = await alignSegment(archived.event, (await materialized(f.storage,archived)), window(1011, 1055), 'speech_candidate', [map()], f.storage, alignment);
  const request = await f.processor.prepareRequest(aligned.segment, aligned.views);
  const replay = new FeatureReplayWorker();
  await assert.rejects(replay.analyze({...request, input_contract: 'paios.media.full-chunks.v1'}, new AbortController().signal), /REPLAY_AUDIO_SELECTION_REQUIRED/);
  request.views[0]!.bytes[0] = request.views[0]!.bytes[0]! ^ 1;
  await assert.rejects(replay.analyze(request, new AbortController().signal), /REPLAY_AUDIO_SELECTION_REQUIRED/);
});
