import assert from 'node:assert/strict';
import test from 'node:test';
import {digest, sha256, type TimeRange} from '../src/contracts.ts';
import type {MediaView} from '../src/media/align.ts';
import {FeatureReplayWorker, type WorkerRequest} from '../src/media/processing.ts';
import {selectPcmView, selectedAudioTimeline, projectSampleInterval} from '../src/media/sample-timeline.ts';

const range = (start_ms: number, end_ms: number, source = false, epoch = 'e1'): TimeRange =>
  ({kind: 'interval', timebase_id: source ? 'source' : 'common', start_ms, end_ms,
    ...(source ? {stream_epoch: epoch} : {})});
const sealed = `l5-view:${digest('fixture')}`;
function selected(start = 0, track = 'mic', epoch = 'e1', seq = 0, scope = range(1000, 2000), drift = 1.1) {
  const bytes = Uint8Array.from({length: 200}, (_, n) => n);
  const view = {ref: `l5-object:${sha256(bytes)}`, chunk: {
    modality: 'audio', format: 'pcm_s16le:1000:1', object_hash: sha256(bytes), bytes: bytes.length,
    track_id: track, stream_epoch: epoch, seq, source_range: range(start, start + 100, true, epoch)
  }, mapped_range: range(1000 + start * drift, 1000 + (start + 100) * drift)} as MediaView;
  return {view, bytes, result: selectPcmView(view, bytes, scope, sealed)};
}
function request(views: WorkerRequest['views'], scope = range(1000, 2000)): WorkerRequest {
  return {input_contract: 'paios.media.selected-pcm.v1', event_id: 'event', segment_id: 'segment',
    archive_revision: 'archive', time_range: scope,
    coverage: {status: 'complete', missing_ranges: [], alignment_uncertainty_ms: 0}, views};
}

test('source-selected binary support and fractional sample projection retain drift and explicit scope clipping', () => {
  const scope = range(1010.25, 1050.25), fixture = selected(0, 'mic', 'e1', 0, scope);
  assert.deepEqual(fixture.result.bytes, fixture.bytes.slice(20, 92));
  const req = request([fixture.result], scope), group = selectedAudioTimeline(req)[0]!;
  const parts = projectSampleInterval(group, 0.5, 36, req);
  assert.equal(parts[0]!.start_sample, 10.5);
  assert.equal(parts[0]!.end_sample_exclusive, 46);
  assert.deepEqual(parts[0]!.source_range, range(10.5, 46, true));
  assert.deepEqual(parts[0]!.mapped_range, range(1011.55, 1050.6));
  assert.deepEqual(parts[0]!.clipped_scope_range, range(1011.55, 1050.25));
  assert.equal(projectSampleInterval(group, 35.9, 36, req)[0]!.clipped_scope_range, null);
});

test('continuous source chunks share cumulative sample positions while gaps, overlaps, tracks and epochs split', () => {
  const req = request([selected().result, selected(100, 'mic', 'e1', 1).result,
    selected(220, 'mic', 'e1', 3).result, selected(250, 'mic', 'e1', 4).result,
    selected(350, 'other', 'e1', 0).result, selected(450, 'other', 'e2', 0).result]);
  const groups = selectedAudioTimeline(req);
  assert.deepEqual(groups.map(g => g.total_samples), [200, 100, 100, 100, 100]);
  assert.deepEqual(groups[0]!.pieces.map(p => [p.start_sample, p.end_sample_exclusive]), [[0, 100], [100, 200]]);
  const parts = projectSampleInterval(groups[0]!, 99.5, 100.5, req);
  assert.deepEqual(parts.map(p => [p.seq, p.start_sample, p.end_sample_exclusive]), [[0, 99.5, 100], [1, 0, 0.5]]);
  assert.deepEqual(groups.map(g => g.id), selectedAudioTimeline(structuredClone(req)).map(g => g.id));
  assert.notEqual(groups[0]!.id, selectedAudioTimeline({...req, archive_revision: 'new'})[0]!.id);
});

test('consumer rejects forged hash, index, support, timebase, epoch and rounding before feature computation', async () => {
  const req = request([selected().result]);
  const mutations: ((r: WorkerRequest) => void)[] = [
    r => {r.views[0]!.bytes[0] = r.views[0]!.bytes[0]! ^ 1;},
    r => {r.views[0]!.pcm_selection!.first_sample = -1;},
    r => {r.views[0]!.pcm_selection!.source_samples = Infinity;},
    r => {r.views[0]!.pcm_selection!.selected_source_range = range(0, 90, true);},
    r => {r.views[0]!.time_range = range(1000, 1099);},
    r => {r.views[0]!.pcm_selection!.mapped_range.timebase_id = 'foreign';},
    r => {r.views[0]!.pcm_selection!.stream_epoch = 'forged';},
    r => {r.views[0]!.pcm_selection!.rounding = 'forged' as never;},
    r => {r.time_range = range(1010, 1090);}
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(req); mutate(copy);
    assert.throws(() => selectedAudioTimeline(copy));
    await assert.rejects(new FeatureReplayWorker().analyze(copy, new AbortController().signal));
  }
});

test('projection recomputes genuine group seal and rejects forged scope, pieces or invalid bounds', () => {
  const req = request([selected().result]), group = selectedAudioTimeline(req)[0]!;
  for (const bounds of [[NaN, 1], [0, Infinity], [-1, 1], [0, 101], [2, 2], [3, 2]])
    assert.throws(() => projectSampleInterval(group, bounds[0]!, bounds[1]!, req), /BOUNDS/);
  const forged = structuredClone(group); forged.pieces[0]!.start_sample = 1;
  assert.throws(() => projectSampleInterval(forged, 0, 1, req), /PROVENANCE/);
  assert.throws(() => projectSampleInterval(group, 0, 1, {...req, segment_id: 'another'}), /PROVENANCE/);
  const forgedBytes = structuredClone(group); forgedBytes.views[0]!.bytes[0] = forgedBytes.views[0]!.bytes[0]! ^ 1;
  assert.throws(() => projectSampleInterval(forgedBytes, 0, 1, req), /PROVENANCE/);
});

test('source integrity, absent sample starts and epoch mismatch fail explicitly', () => {
  const fixture = selected();
  const forged = fixture.bytes.slice(); forged[0] = forged[0]! ^ 1;
  assert.throws(() => selectPcmView(fixture.view, forged, range(1000, 1100), sealed), /INTEGRITY/);
  assert.throws(() => selectPcmView(fixture.view, fixture.bytes, range(1000.1, 1000.2), sealed), /NO_SAMPLES/);
  const view = structuredClone(fixture.view); view.chunk.stream_epoch = 'wrong';
  assert.throws(() => selectPcmView(view, fixture.bytes, range(1000, 1100), sealed), /CLOCK_SCOPE/);
});

 test('visual-only instant replay remains independent of interval audio selection', async () => {
  const req = request([{modality: 'visual', format: 'png', ref: 'frame',
    time_range: {kind: 'instant', timebase_id: 'common', at_ms: 1000}, bytes: Uint8Array.of(1)}]);
  req.time_range = {kind: 'instant', timebase_id: 'common', at_ms: 1000};
  assert.deepEqual(selectedAudioTimeline(req), []);
  const result = await new FeatureReplayWorker().analyze(req, new AbortController().signal);
  assert.equal(result.status, 'partial');
  assert.ok(result.content.visual_observations);
 });

test('negative drift and epsilon snapping preserve the historical ceil selection', () => {
  const scope = range(1010.25, 1050.25);
  const fixture = selected(0, 'mic', 'e1', 0, scope, 0.9);
  assert.equal(fixture.result.pcm_selection!.first_sample, 12);
  assert.equal(fixture.result.pcm_selection!.end_sample_exclusive, 56);
  assert.deepEqual(fixture.result.bytes, fixture.bytes.slice(24, 112));
  const req = request([fixture.result], scope), group = selectedAudioTimeline(req)[0]!;
  const part = projectSampleInterval(group, 0.25, 1.75, req)[0]!;
  assert.equal(part.start_sample, 12.25);
  assert.equal(part.end_sample_exclusive, 13.75);
  assert.equal(part.mapped_range.start_ms, 1011.025);
  const sampleBoundary = 1000 + 10 * 1.1;
  const snapped = selected(0, 'mic', 'e1', 0, range(sampleBoundary, 1000 + 20 * 1.1));
  assert.equal(snapped.result.pcm_selection!.first_sample, 10);
  assert.equal(snapped.result.pcm_selection!.end_sample_exclusive, 20);
});

test('projection binds coverage and ordered sample provenance to the request scope', () => {
  const req = request([selected().result, selected(100, 'mic', 'e1', 1).result]);
  const group = selectedAudioTimeline(req)[0]!;
  const changed = structuredClone(req); changed.coverage.status = 'partial';
  assert.throws(() => projectSampleInterval(group, 0, 1, changed), /PROVENANCE/);
  const reordered = {...req, views: [...req.views].reverse()};
  assert.throws(() => projectSampleInterval(group, 0, 1, reordered), /PROVENANCE/);
  const forged = structuredClone(group); forged.pieces[0]!.view.pcm_selection!.selected_source_range = range(1, 101, true);
  assert.throws(() => projectSampleInterval(forged, 0, 1, req), /PROVENANCE/);
});
