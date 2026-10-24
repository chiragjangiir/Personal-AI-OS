import {materialized} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
import {canonical, digest} from '../src/contracts.ts';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {sha256, type RawEvent, type TrustedContext, type TimeRange, type Json} from '../src/contracts.ts';
import {alignSegment, type ClockMap} from '../src/media/align.ts';
import {MediaProcessor, type Capability, type WorkerPort, type WorkerRequest} from '../src/media/processing.ts';
import {MediaService, type MediaVadPort} from '../src/media/service.ts';
import {selectedAudioTimeline, selectPcmView} from '../src/media/sample-timeline.ts';
import {sampleInput, finalizeSampleSignals, finalizeSampleTranscription, type SampleAudioResult} from '../src/media/sample-results.ts';

const trusted: TrustedContext = {principal_id: 'owner', device_id: 'glasses', device_type: 'glasses',
  consent_ref: 'fixture', channel: 'fixture', submission: 'observation'};
const scope: TimeRange = {kind: 'interval', timebase_id: 'common', start_ms: 0, end_ms: 200};
const maps: ClockMap[] = [{modality: 'audio', track_id: 'mic', stream_epoch: 'epoch', source_timebase_id: 'capture',
  target_timebase_id: 'common', offset_ms: 0, drift_ppm: 0, uncertainty_ms: 1, basis_ref: 'clock:fixture'}];
const cap: Capability = {id: 'generic-sample-producer', version: 'v1', modalities: ['audio'], formats: ['pcm_s16le:16000:1'],
  joint_av: false, healthy: true, permitted: true, max_duration_ms: 1000, execution: 'local', evidence: 'real_verified'};
const alignment = {max_chunks: 20, max_visual_refs: 10, max_frame_gap_ms: 100, max_uncertainty_ms: 2};
function produce(request: WorkerRequest, kind: SampleAudioResult['kind'] = 'transcription'): SampleAudioResult {
  const group = selectedAudioTimeline(request)[0]!;
  return {schema: 'paios.media.audio-sample-result.v1', kind, ...sampleInput(group),
    model: {id: cap.id, version: cap.version, device: 'fixture', native_metadata: {implementation: 'generic'}},
    raw_text: 'Raw annotated speech.', segments: [{start_sample: group.total_samples / 4,
      end_sample_exclusive: group.total_samples * 3 / 4, text: 'annotated', speaker: 'speaker-1'}],
    generation: {eos_reached: true, parser_coverage: 'claimed_complete'}};
}
async function fixture(t: test.TestContext, worker: WorkerPort = {analyze: async request => produce(request)},
  vad: MediaVadPort = {candidates: async request => [produce(request, 'speech_signal')]}) {
  const directory = await mkdtemp(join(tmpdir(), 'media-sample-results-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const storage = new PosixStorage(directory);
  const budget = {max_chunk_bytes: 10000, max_total_bytes: 100000, max_chunks: 20, max_revisions: 20, max_seq: 20};
  const archive = new RawArchive(storage, 10000, undefined, budget), streamArchive = new StreamArchive(storage, budget);
  const processor = new MediaProcessor(storage, new Map([[cap.id, worker]]), {policy_version: 'sample-fixture',
    max_inflight: 2, max_input_bytes: 100000, timeout_ms: 500, allow_external: false, allow_replay: true, allow_partial: true});
  const service = new MediaService({storage, archive, streamArchive, processor, capabilities: async () => [cap], vad,
    align: alignment, max_segments: 4, max_window_ms: 1000, fixtureOnly: true});
  const pcm = new Uint8Array(3200).fill(7);
  const raw: RawEvent = {schema_version: 'paios.event.v1', event_id: 'stream', device_id: 'glasses', device_type: 'glasses',
    captured_at: '2026-10-02T00:00:00.000Z', source: {channel: 'fixture'}, media_type: 'livekit_tracks',
    mime: 'audio/pcm', representation: 'received_decoded_sample', payload: pcm};
  await service.append(raw, trusted, {track_id: 'mic', stream_epoch: 'epoch', seq: 0, modality: 'audio',
    format: 'pcm_s16le:16000:1', source_range: {kind: 'interval', timebase_id: 'capture', stream_epoch: 'epoch', start_ms: 0, end_ms: 100}});
  const archived = await service.append(raw, trusted, {track_id: 'mic', stream_epoch: 'epoch', seq: 1, modality: 'audio',
    format: 'pcm_s16le:16000:1', source_range: {kind: 'interval', timebase_id: 'capture', stream_epoch: 'epoch', start_ms: 100, end_ms: 200}});
  const aligned = await alignSegment(archived.event, (await materialized(storage,archived)), scope, 'speech_candidate', maps, storage, alignment);
  const request = await processor.prepareRequest(aligned.segment, aligned.views);
  const processRequest = {raw_ref: archived.event.raw_ref, archive_revision: archived.event.archive_revision,
    time_range: scope, clock_maps: maps};
  return {storage, service, processor, aligned, request, processRequest};
}

async function evidence(f: Awaited<ReturnType<typeof fixture>>) {
  const keys = await f.storage.list('media-vad-selections');
  return Promise.all(keys.map(async key => ({key, record: JSON.parse(new TextDecoder().decode(
    await f.storage.read('media-vad-selections', key)))})));
}

test('source persists full selected VAD provenance and C/D reference one interval across two chunks', async t => {
  const f = await fixture(t);
  const result = await f.service.process('owner', f.processRequest);
  const rows = await evidence(f); assert.equal(rows.length, 1);
  const {key, record} = rows[0]!;
  assert.equal(digest(record), key);
  assert.equal(record.input.raw_ref, f.processRequest.raw_ref);
  assert.equal(record.input.event_id, f.request.event_id);
  assert.equal(record.input.archive_revision, f.request.archive_revision);
  assert.deepEqual(record.input.time_range, scope);
  assert.equal(record.input.sealed_basis_refs[0], f.request.views[0]!.pcm_selection!.view_ref);
  assert.equal(record.input.selected_views.length, 2);
  assert.ok(record.input.selected_views.every((view: Record<string, unknown>) => !('bytes' in view)));
  assert.deepEqual(record.input.selected_views[0].pcm_selection, f.request.views[0]!.pcm_selection);
  assert.equal(record.result.kind, 'sample_result');
  assert.equal(record.result.candidates.length, 1);
  assert.equal(record.result.candidates[0].source_parts.length, 2);
  assert.equal(record.result.candidates[0].model.id, cap.id);
  assert.equal(result.processed_events.length, 1);
  const d = result.processed_events[0]!;
  assert.ok(d.continuation!.basis_refs.includes(`l5-vad:${key}`));
  assert.deepEqual(d.time_range, {...scope, start_ms: 50, end_ms: 150});
  const again = await f.service.process('owner', f.processRequest);
  assert.deepEqual(again.processed_events, result.processed_events);
  assert.equal((await evidence(f)).length, 1);
});

test('validated silence records true selected source and zero candidates without successful D', async t => {
  const f = await fixture(t, undefined, {candidates: async request => {
    const result = produce(request, 'speech_signal'); result.segments = []; return [result];
  }});
  assert.equal((await f.service.process('owner', f.processRequest)).status, 'no_segments');
  const record = (await evidence(f))[0]!.record;
  assert.equal(record.result.kind, 'sample_result'); assert.deepEqual(record.result.candidates, []);
  assert.equal(record.input.selected_views.length, 2);
  assert.equal(record.result.producers[0].model.id, cap.id);
  assert.equal(record.result.producers[0].input_id, selectedAudioTimeline({...f.request, coverage: record.input.coverage})[0]!.id);
  assert.deepEqual(await f.storage.list('processed-media'), []);
  await f.service.process('owner', f.processRequest);
  assert.equal((await evidence(f)).length, 1);
});

test('legacy labels are bounded and injected model/identity/sourceparts never become evidence authority', async t => {
  const f = await fixture(t, undefined, {candidates: async () => [{start_ms: 50, end_ms: 150,
    semantic_status: 'open', basis: 'legacy-label', model: {id: 'forged', version: 'forged', device: 'forged'},
    source_parts: [], user_identity: 'owner'} as never]});
  await f.service.process('owner', f.processRequest);
  const record = (await evidence(f))[0]!.record, candidate = record.result.candidates[0];
  assert.equal(record.result.kind, 'legacy_candidates');
  assert.equal(candidate.basis, 'legacy-label'); assert.equal(candidate.source_parts.length, 2);
  assert.equal('model' in candidate, false); assert.equal('user_identity' in candidate, false);
  assert.deepEqual(candidate.source_parts.map((part: {seq: number}) => part.seq), [0, 1]);
});

test('invalid VAD and cancellation publish no D; cancellation after immutable selection preserves only valid evidence', async t => {
  const bad = await fixture(t, undefined, {candidates: async request => {
    const result = produce(request, 'speech_signal'); result.pcm_sha256 = 'forged'; return [result];
  }});
  await assert.rejects(bad.service.process('owner', bad.processRequest));
  assert.deepEqual(await evidence(bad), []); assert.deepEqual(await bad.storage.list('processed-media'), []);
  const f = await fixture(t), cancel = new AbortController();
  const publish = f.storage.publish.bind(f.storage);
  f.storage.publish = async (namespace, key, bytes) => {
    const winner = await publish(namespace, key, bytes);
    if (namespace === 'media-vad-selections') cancel.abort();
    return winner;
  };
  await assert.rejects(f.service.process('owner', f.processRequest, cancel.signal), /MEDIA_CANCELLED/);
  assert.equal((await evidence(f)).length, 1);
  assert.deepEqual(await f.storage.list('processed-media'), []);
});

test('historical cached D remains unchanged and old provenance boundary is explicit', async t => {
  const f = await fixture(t, undefined, {candidates: async () => [{start_ms: 0, end_ms: 200,
    semantic_status: 'open', basis: 'historical'}]});
  f.aligned.segment.coverage.status = 'partial';
  f.aligned.segment.continuation.basis_refs.push('clock:synthetic_fixture_unverified');
  const old = await f.processor.process(f.aligned.segment, f.aligned.views, [cap]);
  assert.ok(!old.continuation!.basis_refs.some(ref => ref.startsWith('l5-vad:')));
  const before = canonical(old);
  const result = await f.service.process('owner', f.processRequest);
  assert.equal(canonical(result.processed_events[0]), before);
  assert.ok(result.warnings.includes('HISTORICAL_D_WITHOUT_VAD_SELECTION_EVIDENCE'));
  assert.equal((await evidence(f)).length, 1);
  const changed = {...structuredClone(f.processRequest), previous_processed_event_ids: ['processed:different']};
  await assert.rejects(f.service.process('owner', changed), /MEDIA_INPUT_REVISION_CONFLICT/);
  const stored = JSON.parse(new TextDecoder().decode(await f.storage.read('processed-media',
    digest([f.aligned.segment.raw_ref, f.aligned.segment.segment_id, 1]))));
  assert.equal(canonical(stored), before);
});


test('old pending input is not rewritten to disguise newly added selection provenance', async t => {
  const f = await fixture(t, {analyze: async () => {throw new Error('fixture model failed');}},
    {candidates: async () => [{start_ms: 0, end_ms: 200, semantic_status: 'open', basis: 'legacy'}]});
  f.aligned.segment.coverage.status = 'partial';
  f.aligned.segment.continuation.basis_refs.push('clock:synthetic_fixture_unverified');
  await assert.rejects(f.processor.process(f.aligned.segment, f.aligned.views, [cap]), /ALL_MEDIA_WORKERS_FAILED/);
  const inputKey = (await f.storage.list('processed-media-inputs'))[0]!;
  const before = await f.storage.read('processed-media-inputs', inputKey);
  await assert.rejects(f.service.process('owner', f.processRequest), /MEDIA_INPUT_REVISION_CONFLICT/);
  assert.deepEqual(await f.storage.read('processed-media-inputs', inputKey), before);
  assert.deepEqual(await f.storage.list('processed-media'), []);
  assert.equal((await evidence(f)).length, 1);
});


test('fresh changed VAD evidence cannot be retrofitted into an already published D', async t => {
  let label = 'first-selection';
  const f = await fixture(t, undefined, {candidates: async () => [{start_ms: 50, end_ms: 150,
    semantic_status: 'open', basis: label}]});
  const first = await f.service.process('owner', f.processRequest);
  const original = first.processed_events[0]!;
  const originalRef = original.continuation!.basis_refs.find(ref => ref.startsWith('l5-vad:'))!;
  label = 'changed-selection';
  const second = await f.service.process('owner', f.processRequest);
  assert.deepEqual(second.processed_events, first.processed_events);
  assert.ok(second.warnings.includes('CACHED_D_RETAINS_PRIOR_VAD_SELECTION_EVIDENCE'));
  const rows = await evidence(f); assert.equal(rows.length, 2);
  assert.equal(rows.find(row => `l5-vad:${row.key}` === originalRef)!.record.result.candidates[0].basis, 'first-selection');
  assert.ok(rows.every(row => row.record.processed_event_publication === 'not_asserted'));
});
