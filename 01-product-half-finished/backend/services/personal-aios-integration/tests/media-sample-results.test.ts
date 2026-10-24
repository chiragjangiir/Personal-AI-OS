import {materialized} from './stream-materialized-fixture.ts';
import assert from 'node:assert/strict';
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

test('generic sample transcription policy belongs to actual Processor and keeps unknown identities and partial accuracy', async t => {
  const f = await fixture(t);
  const d = await f.processor.process(f.aligned.segment, f.aligned.views, [cap]);
  assert.equal(d.quality.status, 'partial');
  assert.equal(d.user_identity, 'unknown');
  assert.equal(d.continuation?.semantic_status, 'open');
  assert.ok(d.quality.warnings.includes('TRANSCRIPTION_ACCURACY_UNACCEPTED'));
  assert.equal(d.content.transcript, 'Raw annotated speech.');
  const observations = d.content.audio_observations as {segments: {source_parts: unknown[]}[]; evidence: Json}[];
  assert.equal(observations[0]!.segments[0]!.source_parts.length, 2);
  assert.deepEqual(d.speakers, [{model_local_label: 'speaker-1', user_identity: 'unknown', identity_scope: 'model_local'}]);
});

test('one native signal spanning two chunks becomes one open logical C and one Processor call', async t => {
  const seen: WorkerRequest[] = [];
  const f = await fixture(t, {analyze: async request => {seen.push(structuredClone(request)); return produce(request);}});
  const candidates = finalizeSampleSignals([produce(f.request, 'speech_signal')], f.request, 4);
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0]!.start_ms, candidates[0]!.end_ms], [50, 150]);
  assert.equal(candidates[0]!.source_parts!.length, 2);
  const result = await f.service.process('owner', f.processRequest);
  assert.equal(result.processed_events.length, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.time_range, {...scope, start_ms: 50, end_ms: 150});
  assert.equal(result.processed_events[0]!.continuation?.semantic_status, 'open');
});

test('both source consumers reject producer mutation of scope and bytes against their retained request', async t => {
  const corrupt = (request: WorkerRequest, kind: SampleAudioResult['kind']) => {
    request.time_range = {...scope, end_ms: 199.999};
    request.views[0]!.bytes[0] = request.views[0]!.bytes[0]! ^ 1;
    request.views[0]!.pcm_selection!.selected_sha256 = sha256(request.views[0]!.bytes);
    // Producer can build an internally coherent forged request; retained source input must still reject it.
    return produce(request, kind);
  };
  const f = await fixture(t, {analyze: async request => corrupt(request, 'transcription')});
  await assert.rejects(f.processor.process(f.aligned.segment, f.aligned.views, [cap]), /ALL_MEDIA_WORKERS_FAILED/);
  const g = await fixture(t, undefined, {candidates: async request => [corrupt(request, 'speech_signal')]});
  await assert.rejects(g.service.process('owner', g.processRequest));
  assert.deepEqual(await f.storage.list('processed-media'), []);
});

test('actual Processor rejects mismatched CAP version while legacy behavior remains available', async t => {
  const f = await fixture(t, {analyze: async request => {
    const result = produce(request); result.model.version = 'wrong'; return result;
  }});
  await assert.rejects(f.processor.process(f.aligned.segment, f.aligned.views, [cap]),
    error => (error as {failures?: {reason: string}[]}).failures?.[0]?.reason === 'MEDIA_SAMPLE_RESULT_CAPABILITY_MISMATCH');
});

test('actual Service rejects wrong sample scope/hash and per-candidate budget before publishing D', async t => {
  for (const mutate of [
    (result: SampleAudioResult) => {result.scope_sha256 = 'wrong';},
    (result: SampleAudioResult) => {result.pcm_sha256 = 'wrong';},
    (result: SampleAudioResult) => {result.segments = Array.from({length: 5}, () => ({start_sample: 1, end_sample_exclusive: 2}));}
  ]) {
    const f = await fixture(t, undefined, {candidates: async request => {
      const result = produce(request, 'speech_signal'); mutate(result); return [result];
    }});
    await assert.rejects(f.service.process('owner', f.processRequest));
    assert.deepEqual(await f.storage.list('processed-media'), []);
  }
});

test('source finalizers reject bounds, invalid metadata, wrong kind, omission and duplicate group coverage', async t => {
  const f = await fixture(t);
  const mutations: ((result: SampleAudioResult) => void)[] = [
    result => {result.segments[0]!.start_sample = NaN;},
    result => {result.segments[0]!.end_sample_exclusive = 3201;},
    result => {result.segments[0]!.start_sample = -1;},
    result => {result.generation = {duration: Infinity};},
    result => {result.model.native_metadata = new Date() as unknown as Json;},
    result => {result.sample_count = 12;},
    result => {result.model.id = 'other';},
    result => {result.kind = 'speech_signal';}
  ];
  for (const mutate of mutations) {
    const result = produce(f.request); mutate(result);
    assert.throws(() => finalizeSampleTranscription(result, f.request, cap));
  }
  assert.throws(() => finalizeSampleSignals([], f.request, 4), /COVERAGE/);
  const signal = produce(f.request, 'speech_signal');
  assert.throws(() => finalizeSampleSignals([signal, signal], f.request, 4), /COVERAGE/);
});

test('silence and empty transcription remain honest and do not gain semantic completion from EOS', async t => {
  const f = await fixture(t, undefined, {candidates: async request => {
    const result = produce(request, 'speech_signal'); result.segments = []; return [result];
  }});
  assert.equal((await f.service.process('owner', f.processRequest)).status, 'no_segments');
  const result = produce(f.request); result.raw_text = ''; result.segments = [];
  const finalized = finalizeSampleTranscription(result, f.request, cap);
  assert.equal(finalized.status, 'partial'); assert.deepEqual(finalized.speakers, []);
});


test('source signals keep distinct gap groups and preserve binary support outside C explicitly', async t => {
  const f = await fixture(t);
  const second = structuredClone(f.aligned.views[1]!);
  second.chunk.source_range = {...second.chunk.source_range, kind: 'interval', start_ms: 200, end_ms: 300};
  second.mapped_range = {...scope, start_ms: 200, end_ms: 300};
  const expandedScope = {...scope, end_ms: 300};
  const views = [f.aligned.views[0]!, second].map((view, index) =>
    selectPcmView(view, f.request.views[index]!.bytes, expandedScope, f.request.views[index]!.pcm_selection!.view_ref));
  const req = {...f.request, time_range: expandedScope, views};
  const groups = selectedAudioTimeline(req);
  const results = groups.map(group => ({...produce(f.request, 'speech_signal'), ...sampleInput(group),
    segments: [{start_sample: 0, end_sample_exclusive: group.total_samples}]}));
  const candidates = finalizeSampleSignals(results, req, 4);
  assert.deepEqual(candidates.map(candidate => [candidate.start_ms, candidate.end_ms]), [[0, 100], [200, 300]]);
  assert.ok(candidates.every(candidate => candidate.source_parts!.length === 1));
  const clippedScope = {...scope, end_ms: 199.97};
  const clippedReq = {...f.request, time_range: clippedScope};
  const group = selectedAudioTimeline(clippedReq)[0]!;
  const signal = {...produce(clippedReq, 'speech_signal'), ...sampleInput(group),
    segments: [{start_sample: 3199.75, end_sample_exclusive: 3200}]};
  assert.deepEqual(finalizeSampleSignals([signal], clippedReq, 4), []);
  signal.segments = [{start_sample: 3199, end_sample_exclusive: 3200}];
  const clipped = finalizeSampleSignals([signal], clippedReq, 4)[0]!;
  assert.equal(clipped.end_ms, 199.97);
  assert.equal(clipped.source_parts![0]!.mapped_range.end_ms, 200);
});


test('generic producer semantic extras cannot claim identity or source-owned annotation classification', async t => {
  const f = await fixture(t, {analyze: async request => {
    const result = produce(request);
    Object.assign(result.segments[0]!, {user_identity: 'owner', speaker_identity: 'owner', identity_scope: 'verified',
      source_parts: [], semantic_status: 'complete'});
    Object.assign(result.model, {user_identity: 'owner', authorized: true});
    return result;
  }});
  const d = await f.processor.process(f.aligned.segment, f.aligned.views, [cap]);
  const observation = (d.content.audio_observations as unknown as {segments: Record<string, unknown>[]; model: Record<string, unknown>}[])[0]!;
  const annotation = observation.segments[0]!;
  assert.equal(annotation.speaker_identity, 'unknown');
  assert.equal(annotation.identity_scope, 'model_local');
  assert.equal('user_identity' in annotation, false);
  assert.equal('semantic_status' in annotation, false);
  assert.equal('authorized' in observation.model, false);
  assert.equal('user_identity' in observation.model, false);
  assert.equal((annotation.source_parts as unknown[]).length, 2);
  assert.equal(d.quality.status, 'partial');
});

test('only an on-device capability may report a wake word; malformed wake or language fields are refused', async t => {
  const {request} = await fixture(t);
  const result = (segment: Record<string, unknown>): SampleAudioResult => {
    const value = produce(request); value.segments = [{...value.segments[0]!, ...segment}]; return value;
  };
  const wake = {keyword: '依米', end_sample: 100};
  const local = finalizeSampleTranscription(result({wake, lang: 'zh'}), request, cap);
  const segment = ((local.content.audio_observations as Json[])[0] as {segments: {wake?: typeof wake; lang?: string}[]}).segments[0]!;
  assert.deepEqual([segment.wake, segment.lang], [wake, 'zh']);
  assert.throws(() => finalizeSampleTranscription(result({wake}), request, {...cap, execution: 'external'}), /MEDIA_SAMPLE_RESULT_WAKE_INVALID/);
  for (const bad of [{keyword: '依 米', end_sample: 0}, {keyword: '依米', end_sample: -1}, {keyword: '依米', end_sample: 1e9}, {keyword: '依米'}, '依米'])
    assert.throws(() => finalizeSampleTranscription(result({wake: bad}), request, cap), /MEDIA_SAMPLE_RESULT_ANNOTATION_INVALID/);
  assert.throws(() => finalizeSampleTranscription(result({lang: '<|zh|>'}), request, cap), /MEDIA_SAMPLE_RESULT_ANNOTATION_INVALID/);
});


test('only local owner sample evidence may carry call-only scope and aggregation never drops it',async t=>{
 const f=await fixture(t),result=produce(f.request),local={...cap,speaker_identity:'local_voiceprint' as const};
 result.segments[0]!.speaker='owner';result.segments[0]!.call_only=true;
 const output=finalizeSampleTranscription(result,f.request,local);
 assert.equal((output.speakers![0] as {call_only?:true}).call_only,true);
 assert.throws(()=>finalizeSampleTranscription(result,f.request,cap),/MEDIA_SAMPLE_RESULT_SPEAKER_INVALID/);
 result.segments[0]!.speaker='speaker:other';
 assert.throws(()=>finalizeSampleTranscription(result,f.request,local),/MEDIA_SAMPLE_RESULT_ANNOTATION_INVALID/);
});
