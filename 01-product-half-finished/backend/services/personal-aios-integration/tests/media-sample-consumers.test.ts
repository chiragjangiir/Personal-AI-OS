import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256, type RawEvent, type TimeRange, type TrustedContext} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {StreamArchive} from '../src/stream-archive.ts';
import {FeatureReplayWorker, MediaProcessor, type Capability, type WorkerRequest} from '../src/media/processing.ts';
import {MediaService} from '../src/media/service.ts';
import {selectedAudioTimeline, projectSampleInterval} from '../src/media/sample-timeline.ts';

const at = '2026-10-02T00:00:00.000Z';
const trusted: TrustedContext = {
  principal_id: 'owner', device_id: 'glasses', device_type: 'glasses',
  consent_ref: 'fixture', channel: 'fixture', submission: 'observation'
};
const budget = {max_chunk_bytes: 4000, max_total_bytes: 40000, max_chunks: 20, max_revisions: 20, max_seq: 20};
const range = (start_ms: number, end_ms: number): TimeRange => ({kind: 'interval', timebase_id: 'common', start_ms, end_ms});
const cap: Capability = {
  id: 'feature', version: '1', modalities: ['audio'], formats: ['pcm_s16le:16000:1'], joint_av: false,
  healthy: true, permitted: true, max_duration_ms: 1000, execution: 'local', evidence: 'deterministic_replay'
};

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'paios-sample-consumers-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const storage = new PosixStorage(directory);
  const archive = new StreamArchive(storage, budget);
  const append = (start_ms: number, seq: number) => {
    const payload = Buffer.alloc(1600);
    for (let n = 0; n < 800; n++) payload.writeInt16LE(n + seq * 1000, n * 2);
    const raw: RawEvent = {
      schema_version: 'paios.event.v1', event_id: 'sample-stream', device_id: 'glasses', device_type: 'glasses',
      captured_at: at, source: {channel: 'fixture'}, media_type: 'livekit_tracks', mime: 'audio/pcm',
      representation: 'received_decoded_sample', payload
    };
    return archive.append(raw, trusted, at, {
      track_id: 'mic', stream_epoch: 'e1', seq, modality: 'audio', format: 'pcm_s16le:16000:1',
      source_range: {kind: 'interval', timebase_id: 'samples', stream_epoch: 'e1', start_ms, end_ms: start_ms + 50}
    });
  };
  await append(0, 0);
  await append(50, 1);
  const archived = await append(150, 3);
  return {storage, archive, append, archived};
}

test('source sample intervals pass through VAD, fresh C selection and durable D without flattening an archived gap', async t => {
  const f = await fixture(t);
  let vadInput: WorkerRequest | undefined;
  const workerInputs: WorkerRequest[] = [];
  const replay = new FeatureReplayWorker();
  const processor = new MediaProcessor(f.storage, new Map([['feature', {
    analyze: async (request: WorkerRequest, signal: AbortSignal) => {
      workerInputs.push(structuredClone(request));
      return replay.analyze(request, signal);
    }
  }]]), {
    policy_version: 'sample-consumer.fixture.v1', max_inflight: 2, max_input_bytes: 20000, timeout_ms: 1000,
    allow_external: false, allow_replay: true, allow_partial: true
  });
  const service = new MediaService({
    storage: f.storage, archive: new RawArchive(f.storage, 40000, undefined, budget), streamArchive: f.archive,
    processor, capabilities: async () => [cap], fixtureOnly: true, max_segments: 4, max_window_ms: 1000,
    align: {max_chunks: 20, max_visual_refs: 10, max_frame_gap_ms: 100, max_uncertainty_ms: 5},
    vad: {candidates: async request => {
      vadInput = structuredClone(request);
      const before = structuredClone(request);
      const groups = selectedAudioTimeline(request);
      assert.equal(groups.length, 2);
      assert.deepEqual(groups.map(g => g.views.map(v => v.pcm_selection!.seq)), [[0, 1], [3]]);
      // Acquisition can publish a later chunk while a candidate consumer holds this sealed revision.
      const later = await f.append(200, 4);
      assert.notEqual(later.event.archive_revision, request.archive_revision);
      assert.deepEqual(structuredClone(request), before);
      return groups.map(group => {
        const parts = projectSampleInterval(group, 0, group.total_samples, request);
        const clipped = parts.flatMap(part => part.clipped_scope_range ? [part.clipped_scope_range] : []);
        assert.equal(clipped.length, group.views.length);
        return {start_ms: clipped[0]!.start_ms, end_ms: clipped.at(-1)!.end_ms,
          semantic_status: 'open' as const, basis: 'controlled_sample_positions'};
      });
    }}
  });
  t.after(() => service.close());
  const result = await service.process('owner', {
    raw_ref: f.archived.event.raw_ref, archive_revision: f.archived.event.archive_revision,
    time_range: range(1000.01, 1199.91), clock_maps: [{
      modality: 'audio', track_id: 'mic', stream_epoch: 'e1', source_timebase_id: 'samples',
      target_timebase_id: 'common', offset_ms: 1000, drift_ppm: 2500, uncertainty_ms: 2, basis_ref: 'clock:fixture'
    }]
  });
  assert.equal(result.status, 'processed');
  assert.equal(result.processed_events.length, 2);
  assert.equal(workerInputs.length, 2);
  assert.deepEqual(workerInputs.map(r => r.views.map(v => v.pcm_selection!.seq)), [[0, 1], [3]]);
  const first = result.processed_events[0]!, second = result.processed_events[1]!;
  assert.ok(first.time_range.kind === 'interval' && second.time_range.kind === 'interval');
  if (first.time_range.kind !== 'interval' || second.time_range.kind !== 'interval') return;
  assert.ok(second.time_range.start_ms > first.time_range.end_ms);
  assert.equal(second.time_range.end_ms, 1199.91);
  assert.equal(first.user_identity, 'unknown');
  assert.equal(second.origin, 'device_observation');
  assert.equal(second.continuation?.semantic_status, 'open');
  assert.equal(second.quality.status, 'partial');
  assert.ok(second.quality.warnings.some(w => w.startsWith('PCM_SAMPLE_BOUNDARY_QUANTIZED:')));
  for (const d of result.processed_events) {
    assert.equal(d.raw_ref, f.archived.event.raw_ref);
    assert.equal(d.archive_revision, f.archived.event.archive_revision);
  }
  assert.ok(vadInput!.coverage.missing_ranges.length > 0);
  for (const view of vadInput!.views) {
    const original = await f.storage.read('objects', view.ref.slice('l5-object:'.length));
    const selection = view.pcm_selection!;
    assert.equal(sha256(original.subarray(selection.first_sample * 2, selection.end_sample_exclusive * 2)), selection.selected_sha256);
  }
});

test('out-of-bounds sample results fail before any worker or D publication', async t => {
  const f = await fixture(t);
  let calls = 0;
  const processor = new MediaProcessor(f.storage, new Map([['feature', {analyze: async () => {
    calls++;
    throw new Error('must not run');
  }}]]), {
    policy_version: 'sample-negative.fixture.v1', max_inflight: 2, max_input_bytes: 20000, timeout_ms: 1000,
    allow_external: false, allow_replay: true, allow_partial: true
  });
  const service = new MediaService({
    storage: f.storage, archive: new RawArchive(f.storage, 40000, undefined, budget), streamArchive: f.archive,
    processor, capabilities: async () => [cap], fixtureOnly: true, max_segments: 4, max_window_ms: 1000,
    align: {max_chunks: 20, max_visual_refs: 10, max_frame_gap_ms: 100, max_uncertainty_ms: 5},
    vad: {candidates: async request => {
      const group = selectedAudioTimeline(request)[0]!;
      projectSampleInterval(group, 0, group.total_samples + 0.5, request);
      return [];
    }}
  });
  t.after(() => service.close());
  await assert.rejects(service.process('owner', {
    raw_ref: f.archived.event.raw_ref, archive_revision: f.archived.event.archive_revision,
    time_range: range(1000, 1200), clock_maps: [{
      modality: 'audio', track_id: 'mic', stream_epoch: 'e1', source_timebase_id: 'samples',
      target_timebase_id: 'common', offset_ms: 1000, drift_ppm: 0, uncertainty_ms: 2, basis_ref: 'clock:fixture'
    }]
  }), /MEDIA_PCM_PROJECTION_BOUNDS_INVALID/);
  assert.equal(calls, 0);
});
